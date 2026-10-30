# Staging deployment + scheduler

This is the runbook for getting the game playable end-to-end on a hosted
staging environment, including phase advancement while **every player is idle**.

It is intentionally small: no new auth, no realtime changes, no route
refactors. The only new moving part is one cron endpoint that calls the
existing `tick_room` RPC.

---

## 1. Prerequisites

- A Supabase project (hosted).
- A Vercel project (or any Node host that can run `next start`).
- Supabase CLI (`supabase`) and, for the scheduler, either a 5-second pinger
  (small VM / external cron service) or Supabase `pg_cron`.

---

## 2. Environment variables

Set these **before the build**. `NEXT_PUBLIC_*` values are inlined by Next at
build time, so changing them after a build has no effect and will produce a
session/401 mismatch.

| Variable | Required | Scope | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | build + runtime | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | build + runtime | publishable/anon key (`sb_publishable_...` or legacy JWT) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | runtime (server only) | secret key; never expose to the browser |
| `SCHEDULER_SECRET` | yes | runtime (server only) | ≥32 chars; bearer token for `/api/cron/advance` |
| `DATABASE_URL` | tests only | runtime | direct Postgres URL for integration tests; app never reads it |

Generate the scheduler secret with `openssl rand -hex 32`.

---

## 3. Supabase setup

1. **Enable Anonymous sign-ins**
   Dashboard → Authentication → Providers → **Anonymous** → enable.
   The app signs every visitor in anonymously; with this off, every API call
   returns `401 Authentication required.`

2. **Push the migrations** (append-only, `0001`–`0029`):

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push
   ```

   The migrations create the schema, RLS, RPCs, and attach the public tables to
   the `supabase_realtime` publication.

3. **Verify**:

   ```sql
   select count(*) from public.rooms;             -- table exists
   select proname from pg_proc
    where proname in ('tick_room','create_room','start_game','cast_vote');
   ```

---

## 4. Deploy to Vercel

```bash
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SCHEDULER_SECRET production
vercel --prod
```

Or connect the repo in the dashboard and set the same four variables for the
Production environment, then deploy. Record the resulting URL as the staging
URL.

---

## 5. Scheduler (advance phases with zero players online)

The endpoint is:

```
POST /api/cron/advance
Authorization: Bearer <SCHEDULER_SECRET>
```

It scans `rooms` that are `in_progress` and past `phase_ends_at`, then calls the
existing `tick_room` RPC for each. `tick_room` already takes the row lock and is
idempotent, so overlapping calls are safe — there is no new concurrency system.

### Option A — 5-second external loop (matches the requirement)

Run `scripts/cron-advance.sh` on any always-on box (or a container):

```bash
STAGING_URL=https://your-app.vercel.app \
SCHEDULER_SECRET=... \
./scripts/cron-advance.sh
```

It POSTs every 5 seconds and prints the JSON summary.

### Option B — Supabase `pg_cron` (1-minute granularity)

`pg_cron` cannot express "every 5 seconds" (cron syntax is minute-level), but it
is the simplest fully-managed option. Run once in the SQL editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'advance-werewolf-rooms',
  '* * * * *',                         -- every minute
  $$
  select net.http_post(
    url     := 'https://your-app.vercel.app/api/cron/advance',
    headers := jsonb_build_object('Authorization', 'Bearer <SCHEDULER_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

### Option C — Vercel Cron

Not used here. Vercel Cron invokes with `GET` and its minimum cadence is far
slower than 5 seconds (once/day on Hobby, once/minute on Pro), so it cannot
drive this endpoint as written. Use A or B.

---

## 6. Manual playtest (2–3 browsers)

Use separate browser profiles (or one normal + one incognito) so each gets a
distinct anonymous user.

1. Browser A: create a room, copy the room code.
2. Browsers B and C: join with the code + a display name.
3. Everyone toggles **Ready**. Host starts the game.
4. **Night**: each role submits an action (Werewolf eliminate, Seer
   investigate, Guardian Angel protect). Leave at least one tab open.
5. Wait for the phase deadline. With the scheduler running, the phase must
   advance even if no one clicks anything.
6. **Day → Voting**: cast votes; wait for resolution.
7. Continue until a winner is shown.

Record, per step: HTTP status, any `401/403/500`, console errors, and whether
the Realtime update arrived without a manual refresh.

---

## 7. What to report back

- Staging URL.
- Whether Anonymous sign-ins are enabled.
- Whether `db push` applied all 29 migrations cleanly.
- The output of one cron invocation (`scanned` / `advanced`).
- Any RLS or Realtime errors seen in the browser console or Supabase logs.
