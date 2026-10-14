# Implementation Plan

## Ground rules for every phase

1. Migrations are append-only, numbered, and reproducible. Never hand-edit production schema.
2. RLS is written **before** any client access is opened. Private tables get *no* policies.
3. Business logic lives in `src/lib/game/*` as pure, testable modules. API handlers only do
   auth → parse → validate → call service → shape response.
4. Nothing claims to work unless it is actually connected to Postgres and covered by a test.
   No fake-success mocks.
5. After every phase: `npm run lint && npm run typecheck && npm test` must be green.
6. Secrets never enter the repo, the client bundle, or logs.

---

## License boundary (recurring decision)

`GreyWolfDev/Werewolf` is **GPL-3.0-only**. We implement its *rules* (not copyrightable) with
**no code copied**. This repo is therefore currently unencumbered. If that ever changes — i.e.
if GPL-3.0 source is copied in — this entire repository becomes GPL-3.0 and must ship with
source under that license. See `docs/REFERENCE-ANALYSIS.md`.

---

## Framework decisions (Next.js 16.4 — verified against bundled docs)

| Decision | Rationale |
| --- | --- |
| `params` is a `Promise` in dynamic routes | Next 16 removed synchronous access to `params`, `cookies()`, `headers()`. Always `await`. |
| Use the generated `RouteContext<'/api/rooms/[roomId]'>` type | Built-in, gives typed `params` per route without hand-written casts. |
| **`cacheComponents` disabled** (changed from the scaffold default) | With `cacheComponents: true`, Next 16 **removes** `export const dynamic`, `revalidate`, `dynamicParams`, and `fetchCache`. This app is 100 % dynamic (every request touches auth cookies + Supabase), so those knobs are dead weight and their removal is a footgun. Restoring classic behaviour makes GET handlers dynamic by default. |
| `src/proxy.ts` (not `middleware.ts`) | `middleware` is deprecated in favour of `proxy` in Next 16. Note: `proxy` is Node-runtime only and throws if you set `runtime` in it. Always use a `config.matcher`. |
| `next lint` is gone | `package.json` uses `"lint": "eslint"`, and `next build` no longer lints. Lint runs as its own step in CI. |

## Concurrency & scheduling design (the hard part)

Phase advancement must be atomic, idempotent, and correct under concurrent requests. Chosen
mechanism — **optimistic claim with a verified token**, no long-held row locks:

```
1. CLAIM  UPDATE rooms
          SET state_version   = state_version + 1,
              transition_claim = <random uuid>
          WHERE id = :room
            AND phase = :expected_phase
            AND phase_ends_at <= now()
            AND state_version = :expected_version
            AND (transition_claim IS NULL
                 OR transition_claimed_at < now() - :claim_timeout)   -- stale-claim recovery
          RETURNING *;
          -- 0 rows => someone else already claimed it. STOP, no side effects.

2. COMPUTE  run the pure engine module against the returned snapshot. No DB writes.

3. COMMIT UPDATE rooms SET phase=..., phase_ends_at=..., transition_claim=NULL
          WHERE id = :room AND transition_claim = :my_claim;
          -- 0 rows => the claim expired and was stolen. DISCARD the computed result.
```

Why not `SELECT … FOR UPDATE` held across the whole resolution: PRD §17 forbids long
transactions over many rooms, and holding a lock across a multi-statement resolution invites
timeouts and lock pile-up. A single-statement conditional `UPDATE` gives the same mutual
exclusion with a bounded statement.

Stale-claim recovery is what makes this resilient: if the claiming process dies mid-resolution,
the claim expires and the next request re-does the work. Combined with a unique
`(room_id, round_number, actor_player_id, action_type)` key on `game_actions`, replaying a
resolution is idempotent rather than duplicating.

**Scheduler strategy (PRD §17).** Preferred order. **Only the third option is built. The
first two are neither implemented nor deployed** — see `src/lib/server/phase-advancement.ts`
for what actually runs.

1. `pg_cron` / Supabase scheduled invocation — **if** available on the project's plan.
   Not configured on any project.
2. `POST /api/internal/advance-phases` called by an external scheduler — **not
   implemented. There is no `src/app/api/internal/` directory in the tree**, so no
   secret-authenticated endpoint exists for a scheduler to call. Building it is part of
   the remaining scheduling work.
3. **Lazy advancement — the only trigger that ships.** `GET /api/rooms/{id}`,
   `POST .../actions` and `POST .../votes` call `advanceRoomPhaseIfExpired(roomId)` first,
   which claims and resolves any overdue transition **before** serving the request.

The honest limitation of option 3, per PRD §17.5 and acceptance criterion 20.13: **without
a real periodic scheduler, a phase transition only happens when a player touches the
room.** An idle lobby can sit past its deadline. We do *not* claim transitions are on time
in that mode, and the UI is told the truth — see `docs/RESOURCE-LIMITS.md` § "Scheduler
truthfulness".

**Rate limiting** uses a Postgres counter table with an atomic upsert, never in-process memory,
because Vercel serverless instances do not share memory (PRD §18.B).

---

## Phase breakdown

### Phase 1 — Foundation  ← *this session*

| Step | Deliverable |
| --- | --- |
| 1.1 | Scaffold Next.js 16 + TS + Tailwind, `src/` layout, ESLint |
| 1.2 | `docs/` — rules spec, reference/license analysis, this plan, resource limits |
| 1.3 | `.env.example`, zod-validated env module, documented setup |
| 1.4 | Migration `0001_schema` — enums, all tables, indexes, constraints, cascade rules |
| 1.5 | Migration `0002_rls` — helper functions, per-table policies, private-table lockdown, grants |
| 1.6 | Migration `0003_functions` — atomic RPCs (join/leave/start/action/vote/advance-claim/commit) |
| 1.7 | Supabase server + browser clients, auth/session helpers |
| 1.8 | Game engine modules (registry, assignment, config validation, night/vote resolution, win condition, phase manager) — pure, no I/O |
| 1.9 | Zod schemas + DB row types |
| 1.10 | Vitest harness + unit & security tests |
| 1.11 | Lint, typecheck, test green |

### Phase 2 — Room & lobby
`POST /api/rooms`, `POST /api/rooms/join`, `GET /api/rooms/:id`, `POST /api/rooms/:id/leave`,
host settings update, realtime roster subscription (public tables only).

### Phase 3 — Roles & private data
`POST /api/rooms/:id/start`, `GET /api/rooms/:id/me`, role-config endpoints, security tests for
role secrecy, host-cannot-see-roles test.

### Phase 4 — Core loop
`POST /api/rooms/:id/actions`, `POST /api/rooms/:id/votes`, night + vote resolution service,
elimination, win condition, atomic transitions.

### Phase 5 — Scheduling
**Partly done.** The claim/commit RPCs are built, and the lazy-advancement fallback
(`advanceRoomPhaseIfExpired` in `src/lib/server/phase-advancement.ts`) is built and
covered by tests. **Not built:** the `POST /api/internal/advance-phases` endpoint (there is
no `src/app/api/internal/` directory), the cleanup job, the retention/TTL sweep, and
reconnect handling.

### Phase 6 — UI & hardening
Game UI, countdown, error/loading states, mobile, integration tests, deploy to Vercel.

---

## File layout

The target layout from the plan. **Not a description of the current tree** — entries that
do not exist yet are marked `(not built)`. `README.md` § "What is implemented" is the
authoritative list of what is actually present.

```
src/
  app/
    page.tsx                                    # home (create/join)
    rooms/[roomId]/page.tsx                     # lobby + game (phase-driven)
    rooms/[roomId]/loading.tsx, error.tsx
    api/
      rooms/route.ts                            # POST create
      rooms/join/route.ts                       # POST join
      rooms/[roomId]/route.ts                   # GET snapshot
      rooms/[roomId]/my-role/route.ts           # GET own secret (planned as `me/`)
      rooms/[roomId]/start/route.ts             # POST
      rooms/[roomId]/ready/route.ts             # POST  (not in the original plan)
      rooms/[roomId]/actions/route.ts           # POST night action
      rooms/[roomId]/votes/route.ts             # POST vote
      rooms/[roomId]/dev-add-bots/route.ts      # POST dev-only (not in the original plan)
      rooms/[roomId]/leave/route.ts             # POST              (not built)
      rooms/[roomId]/settings/route.ts          # POST host settings (not built)
      rooms/[roomId]/events/route.ts            # GET paginated public events (not built)
      internal/advance-phases/route.ts          # POST scheduler (secret-auth) (not built)
      internal/cleanup/route.ts                 # POST retention sweep (secret-auth) (not built)
  lib/
    env.ts                                      # zod-validated env (server)
    supabase/client.ts                          # browser client
    supabase/server.ts                          # server client (cookies) + admin client
    server/auth.ts                              # requireUser / requireRoomMember
    server/api.ts                               # json helpers, error envelope
    server/rate-limit.ts                        # db-backed limiter
    game/
      types.ts
      settings.ts                               # all tunables + defaults
      role-registry.ts                          # ★ add roles here
      role-assignment.ts
      config-validation.ts
      night-resolution.ts
      vote-resolution.ts
      win-condition.ts
      phase-manager.ts
      action-validation.ts
    schemas/{room,player,game-action,vote,settings}.ts
  types/database.ts, game.ts
supabase/
  migrations/0001_schema.sql
  migrations/0002_rls.sql
  migrations/0003_functions.sql
  seed.sql
  tests/rls.spec.sql                            # pgTAP-style checks, run in CI w/ a real DB
scripts/migrate.mjs                             # applies migrations in order
tests/unit/*.test.ts
tests/security/*.test.ts
tests/integration/*.test.ts                     # skip w/o DATABASE_URL
docs/*.md
```
