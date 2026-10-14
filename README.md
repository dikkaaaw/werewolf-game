# Werewolf — Online

Private-room Werewolf for 10–20 players. Next.js (App Router) + TypeScript + Tailwind +
Supabase (Postgres, Auth, Realtime).

> **Status: implemented in code, not deployed.** The database, RLS, RPC layer, the pure
> game engine, the landing page, the room page (lobby and in-game), all nine API route
> handlers and their test suites are present and pass. What has **not** been verified from
> this environment: any deployment, any hosted-Supabase integration run, and any live
> Realtime session — those need a real Supabase project and a deployed app, neither of
> which is set up here. See
> [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) for what is left. Nothing
> below claims a feature works unless a test covers it.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/GAME-RULES.md`](docs/GAME-RULES.md) | The normative rules this engine implements |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | Architecture, concurrency design, phase plan, framework decisions |
| [`docs/RESOURCE-LIMITS.md`](docs/RESOURCE-LIMITS.md) | Rate limits, retention, free-tier limits, scheduler truthfulness |
| [`docs/REFERENCE-ANALYSIS.md`](docs/REFERENCE-ANALYSIS.md) | Reference-repo mechanics + GPL-3.0 license analysis |
| [`docs/ROLE-REVEAL-DESIGN.md`](docs/ROLE-REVEAL-DESIGN.md) | How and when a player's own role becomes visible |
| [`docs/LOCAL-STACK.md`](docs/LOCAL-STACK.md) | Running the whole stack on a laptop, with no hosted project |

## What is implemented

Derived from the tree, not from intent.

| Area | State |
| --- | --- |
| Database | Migrations `0001`–`0010` — schema, RLS, RPCs, then seven targeted fixes (see the table below) |
| Game engine | Pure and I/O-free: role assignment, night resolution, vote resolution, win conditions, the phase machine, action validation |
| Auth | Anonymous sign-in through Supabase (`src/components/auth/AuthProvider.tsx`). **There are no accounts, passwords or a login screen.** |
| Landing page | Create a room, or join one with a room code plus a display name |
| Room page | Lobby (seats, ready-up, host start gate, chat) and in-game (role card, roster, phase banner, chat, game-over panel) |
| API routes | `POST /api/rooms`, `POST /api/rooms/join`, `GET /api/rooms/{id}`, `GET /api/rooms/{id}/my-role`, `POST /api/rooms/{id}/ready`, `POST /api/rooms/{id}/start`, `POST /api/rooms/{id}/actions`, `POST /api/rooms/{id}/votes`, plus `POST /api/rooms/{id}/dev-add-bots` (refuses to run outside `NODE_ENV=development`) |
| Phase advancement | Lazy only: the next request to a room advances an expired phase (`src/lib/server/phase-advancement.ts`). No scheduler is wired up. |
| Realtime | Subscribed in the room page (`postgres_changes` over a channel), with unit coverage for the lobby subscription. **Not verified against a live Supabase instance.** |
| Deployment | **Not deployed.** No target provisioned, nothing to verify. |

### Not implemented

- `POST /api/internal/advance-phases` — the external-scheduler trigger described in the
  design docs. **No such route exists**, so the scheduler options below are a plan, not a
  working feature; lazy advancement is the only trigger the app ships.
- Any scheduler at all — see "Scheduler limitation" near the end of this file.

## Quick start

```bash
npm install
cp .env.example .env.local     # then fill in the Supabase values
npm run dev
```

### Environment variables

| Variable | Required | Where it goes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | browser + server (safe; RLS protects the data) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **server only** — bypasses RLS, never sent to the browser |
| `SCHEDULER_SECRET` | yes | server only — required by `serverEnvSchema`; reserved for an internal scheduler endpoint that **does not exist yet**, so today it is validated but unused (see the scheduler limitation below) |
| `DATABASE_URL` | tests only | direct Postgres connection, used by integration tests |

Generate the scheduler secret with `openssl rand -hex 32`.

`src/lib/env.ts` validates these with Zod on first use, and
`src/lib/supabase/server.ts` is marked `server-only`, so importing the service-role
client into a component is a **build error**, not a runtime leak.

## Database

Migrations are append-only and numbered. Apply them in order:

```bash
# Against a real Supabase project:
supabase db push

# Or against a local Postgres (see below):
npm run db:reset
```

| File | Contents |
| --- | --- |
| `supabase/migrations/0001_schema.sql` | Enums, all tables, indexes, constraints, cascades |
| `supabase/migrations/0002_rls.sql` | Helper functions, RLS policies, private-table lockdown, grants |
| `supabase/migrations/0003_functions.sql` | Atomic RPCs + the privilege lockdown that follows them |
| `supabase/migrations/0004_fix_gen_random_bytes_qualification.sql` | Qualify `gen_random_bytes` so it resolves on a bare Postgres |
| `supabase/migrations/0005_add_player_ready_state.sql` | Per-player ready flag for the lobby gate |
| `supabase/migrations/0006_finish_game_persists_eliminations.sql` | `finish_game` writes the eliminations that triggered the win |
| `supabase/migrations/0007_enforce_forbid_repeat_target.sql` | One-shot roles may not repeat last night's target |
| `supabase/migrations/0008_enforce_min_five_players.sql` | `start_game` refuses a lobby below five players |
| `supabase/migrations/0009_enforce_same_role_targeting.sql` | Refuse targets that share the actor's role |
| `supabase/migrations/0010_release_phase_transition_claim.sql` | Release a phase claim that never settled, so the room cannot freeze |

SQL assertions live beside them, never applied as migrations:

| File | Contents |
| --- | --- |
| `supabase/tests/harness.sql` | Local-only `auth.users` / `auth.uid()` stand-in. **Never run in production.** |
| `supabase/tests/security.sql` | RLS, privilege and grant assertions |
| `supabase/tests/gameplay.sql` | Game-flow scenarios (lynch, night kill, idempotent finish, forged claim, claim release) |
| `supabase/tests/concurrency.sql` | Claim exclusivity under concurrent workers (guarded to an allow-listed local database) |

### Running the SQL suites locally

The migrations are written for Supabase, which provides `auth.users`, `auth.uid()` and
the `anon` / `authenticated` / `service_role` roles. To run them on a bare Postgres,
`supabase/tests/harness.sql` stands up an equivalent stub.

```bash
# One-time: a private Postgres cluster you can write to (no sudo needed)
PGBIN=/usr/lib/postgresql/16/bin
mkdir -p /tmp/opencode/wolfpg
$PGBIN/initdb -D /tmp/opencode/wolfpg/data -U postgres --auth=trust
$PGBIN/pg_ctl -D /tmp/opencode/wolfpg/data \
  -o "-p 55432 -k /tmp/opencode/wolfpg -c listen_addresses=127.0.0.1" \
  -l /tmp/opencode/wolfpg/server.log -w start

# Reset the local database from the migrations, then run
# security.sql, gameplay.sql and concurrency.sql
npm run db:test:security
```

The script resets the local database before each suite and **refuses to run against any
non-local, non-allow-listed database** — it never touches a hosted project.

These assert, among other things, that:

- `player_secrets`, `game_actions` and `game_action_results` are unreachable from a
  client session
- the **host** cannot read any player's role
- non-members cannot read a room, roster, votes or events
- every mutation RPC is `EXECUTE`-denied to `anon` and `authenticated`
- a villager cannot submit a werewolf action, and a seer cannot protect
- targets from another room are refused
- the phase-transition claim is exclusive and a claim cannot be committed twice
- cleanup never deletes an in-progress room
- a game-ending lynch or night kill is persisted along with the winner, and re-finishing
  changes nothing
- a forged or stale claim writes nothing
- a phase claim that never settled can be released, so a room cannot stay frozen

## Tests

```bash
npm test              # unit + security + gated suites (skipped without their env vars)
npm run test:coverage
npm run verify        # lint + typecheck + test
npm run db:test:security   # SQL assertions, needs local Postgres
```

| Suite | Tests | Gate |
| --- | --- | --- |
| `tests/unit/` — role registry, assignment, config validation, night/vote resolution, win conditions, phase machine, action validation, component renders, phase advancement against real RPCs | 431 | none (33 files) |
| `tests/security/` — request-schema boundaries, role privacy, env validation | 48 | none |
| `tests/integration/game-loop.test.ts` — full loop through the Supabase client | 9 | `DATABASE_URL` + `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, with a reachable API endpoint |
| `tests/integration/sql-e2e.test.ts` — the same loop against real Postgres RPCs | 7 | `LOCAL_PG_URL` (direct connection; no API endpoint needed) |
| `tests/e2e/http-game-loop.test.ts` — over HTTP against a running app | 20 | `E2E_BASE_URL` + Supabase credentials |

Gated suites **skip with a message** when their variables are absent. They are reported
as skipped, never as passed — a vacuously green suite would be worse than an honest
skip.

```bash
# Full local run, no API endpoint required (direct Postgres RPCs):
LOCAL_PG_URL=postgresql://user@/werewolf_test?host=/path/to/socket&port=5432 npm test

# Plain `npm test` runs 479 and skips 36 (the three gated suites above).
```

## Architecture notes

**The engine is pure.** `src/lib/game/*` performs no I/O. Every rule — role assignment,
night resolution, vote resolution, win conditions, the phase machine — is a deterministic
function that is unit-testable in isolation, and the same function runs unchanged on the
server and under test.

**The database is the source of truth.** No endpoint trusts anything the client says
about who it is or what the world looks like. Identity comes only from a verified auth
session; no API accepts `user_id` or `player_id` from a request body as authorisation.

**Phase transitions use an optimistic claim**, not a long-held row lock — see
[the design notes](docs/IMPLEMENTATION-PLAN.md#concurrency--scheduling-design-the-hard-part).
A single conditional `UPDATE` wins the right to resolve a phase; a competing request
gets zero rows and stops without side effects. A stale claim expires, so a crashed
worker self-heals.

**Rate limiting lives in Postgres**, not in process memory, because serverless instances
do not share memory.

## ⚠️ Scheduler limitation (read before deploying)

Phase advancement needs something to *trigger* it. Options, in order of preference:

1. `pg_cron` / Supabase scheduled invocation on a 10–30 s interval — **preferred, not set
   up.**
2. An external scheduler hitting `POST /api/internal/advance-phases` — **planned only;
   no such route exists in the tree** (see
   [Not implemented](#not-implemented)).
3. **Lazy advancement — the only trigger currently wired:** a phase advances the next time
   any player makes a request to that room
   (`src/lib/server/phase-advancement.ts`).

**Vercel Hobby Cron fires at most once per day** and cannot drive per-minute transitions.
In mode 3 a room with no player traffic can sit past its deadline. The system does not
claim transitions are on time in that mode, and **no scheduler of any kind has been
deployed or verified**. If on-time advancement is a hard requirement, provision a real
sub-daily scheduler before production — that is a deployment prerequisite, not a code
change.

Full details, including how to monitor for a dead scheduler:
[`docs/RESOURCE-LIMITS.md`](docs/RESOURCE-LIMITS.md#scheduler-truthfulness).

## Licence note

This is an independent, clean-room implementation. The reference project
[`GreyWolfDev/Werewolf`](https://github.com/GreyWolfDev/Werewolf) is **GPL-3.0-only**;
no code from it is copied here, only its (uncopyrightable) game mechanics were studied.
See [`docs/REFERENCE-ANALYSIS.md`](docs/REFERENCE-ANALYSIS.md).
