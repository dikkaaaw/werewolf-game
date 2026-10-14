# Local Supabase-compatible stack (integration + HTTP E2E)

Integration and E2E tests need more than a bare Postgres: they need
**Supabase Auth (GoTrue)** and **PostgREST**, because `supabase-js` speaks to both.

Normally you would run `supabase start`, which needs Docker. This repo instead runs the
two services as plain static binaries against a local Postgres, so the suites work on a
machine with no Docker daemon and no Supabase CLI.

Everything binds to **127.0.0.1** and targets a scratch database. Nothing here reads
`.env` / `.env.local`, so the hosted project cannot be contacted by accident.

## Components

| Piece | What it is | Port |
| --- | --- | --- |
| Postgres | existing scratch instance (`/tmp/opencode/wolfpg`) | 55432 |
| GoTrue | `supabase/auth` binary — issues real JWTs, `/admin/users` | 9999 |
| PostgREST | `PostgREST/postgrest` binary — the RPC/table surface | 3001 |
| Gateway | `scripts/supastack-proxy.mjs` — stands in for Kong | 54321 |
| Next.js | the app under test | 3100 |

The gateway exists because `supabase-js` derives the **auth** base URL from
`NEXT_PUBLIC_SUPABASE_URL` too. Hosted Supabase fronts both services with Kong:

```
/rest/v1/*  -> PostgREST
/auth/v1/*  -> GoTrue
```

Pointing `NEXT_PUBLIC_SUPABASE_URL` straight at PostgREST makes every auth call fail with
`Invalid path specified in request URL`. Rather than change the test suite (it must keep
working against hosted Supabase unchanged), the proxy reproduces that routing — including
stripping the prefix before forwarding, exactly as Kong does.

## Usage

```bash
# 1. Bring up the stack (downloads binaries on first run, creates werewolf_e2e,
#    runs GoTrue migrations, then the test harness + game migrations).
./scripts/supastack-local.sh install
./scripts/supastack-local.sh up
./scripts/supastack-local.sh status

# 2. Export the environment for the test run.
eval "$(./scripts/supastack-local.sh env)"

# 3. Integration tier — Auth + PostgREST + Postgres, no Next.js needed.
npm run test:integration

# 4. HTTP/E2E tier — additionally needs the app running.
npm run build
npx next start -H 127.0.0.1 -p 3100
export E2E_BASE_URL=http://127.0.0.1:3100
npm run test:e2e

# 5. Tear down.
./scripts/supastack-local.sh down
```

## Configuration

No database credential is stored in `scripts/supastack-local.sh`. The PostgREST login is
read from the environment, or from a git-ignored **`.supastack.env`** at the repo root if
that file exists (it is sourced before the defaults, so anything it sets wins):

| Variable | Default | What it is |
| --- | --- | --- |
| `SUPASTACK_PGRST_DB_USER` | `authenticator` | Postgres role PostgREST logs in as, then switches to `anon` |
| `SUPASTACK_PGRST_DB_PASSWORD` | *(empty)* | Its password. Under the local cluster's `trust` auth Postgres ignores it; it is only part of the connection URI. |
| `SUPASTACK_DB` | `werewolf_e2e` | Scratch database name |
| `SUPASTACK_STATE` | `/tmp/opencode/supastack` | Where binaries, logs and the generated JWT secret live |
| `SUPASTACK_AUTH_PORT` / `SUPASTACK_PGRST_PORT` / `SUPASTACK_PROXY_PORT` | `9999` / `3001` / `54321` | Loopback ports |

`.supastack.env` is listed in `.gitignore`. Nothing here should ever point off-box, so do
not put a hosted credential in it.

> **Known gap: the `authenticator` role is not created anywhere in this repo.**
> `supabase/tests/harness.sql` creates `anon`, `authenticated` and `service_role`, but no
> login role. PostgREST cannot connect until one exists in the scratch database — e.g.
> `create role authenticator login; grant anon to authenticator;`. Run that yourself if you
> need the PostgREST tier; **it has not been exercised in this environment.**

## Gotchas this already handles

Recorded here because each one cost real debugging time and none is obvious.

- **PostgREST ≥ 13 has no `/health` route** — it 404s. The OpenAPI root (`/`) is the
  liveness probe.
- **GoTrue needs `search_path=auth`** on its connection string (hosted Supabase supplies
  this). Without it, admin user creation fails with
  `relation "identities" does not exist` — GoTrue queries its tables unqualified.
- **GoTrue's first migration fails on a bare Postgres** with `SQLSTATE 3F000: schema
  "auth" does not exist`. Supabase pre-creates that schema; create it first.
- **`setsid` may fork, so `$!` is not the daemon's pid.** `down` therefore resolves
  listeners by port. This matters a lot: an orphaned GoTrue keeps holding port 9999, the
  newly started one exits with `Address in use`, and the health check happily reports UP
  while requests are served by the **old** process with its **old** configuration. The
  symptom is a fix that "didn't take".
- **Do not pipe this script's output to `tail`.** The daemons keep the pipe open, so `tail`
  never sees EOF and the command appears to hang.
- **`src/lib/env.ts` only accepts `https://` or `http://localhost`** for
  `NEXT_PUBLIC_SUPABASE_URL`. The gateway is therefore advertised as `localhost`, even
  though it binds to `127.0.0.1`.
- **PostgREST schema cache**: changing a function signature needs a reload before the new
  argument is visible over HTTP. `up` recreates the database, so this never bites locally,
  but it is a real deploy step — see the note in migration `0006`.

## Test tiers

| Tier | Command | Needs |
| --- | --- | --- |
| Unit | `npm test` | nothing |
| SQL / RLS | `npm run db:test:security` | local Postgres |
| Integration | `npm run test:integration` | `supastack-local.sh up` |
| HTTP E2E | `npm run test:e2e` | stack **and** a running Next server |

Without the relevant environment, integration and E2E **skip** and are reported as skipped,
never as passed. A vacuous green suite is worse than an honest skip.