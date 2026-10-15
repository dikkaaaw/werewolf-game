# Pending Game Actions Design (E2, SUPERSEDED)

> **Superseded.** The generic `game_pending_actions` framework this document
> proposed was built in 0012 but never consumed by the game; the Hunter shipped
> on a separate death-resolution path. Both layers are being removed in favour
> of a per-player `prompt` with a deadline, resolved by `tick_room`. See
> `docs/SIMPLIFICATION-PLAN.md`. This file is kept for history only.

No code, migration, schema, or remote Supabase change is made by this document.

## Options considered

| Option | Prior art / fit | Strengths | Limitations | Verdict |
| --- | --- | --- | --- | --- |
| Supabase scheduled function | No scheduler is configured or verified in this repository | Native if available | Must verify platform and permissions | Not verified yet |
| Provider scheduled job | Deployment platform is Vercel/Next; `next.config.ts` provides no scheduler | Simple operational fit | Provider plan and allowed frequency must be checked manually | Candidate |
| Request-driven recovery plus `next` periodic trigger | None; only request-time logic exists (`advanceRoomPhaseIfExpired`) | Reuses current request-triggered pattern | No guaranteed recovery if all clients disconnect | Insufficient alone |

## Recommended design

Use an authenticated external scheduler job calling a secured Next.js API endpoint at a fixed interval (e.g., 5 seconds), with request-time recovery as a secondary path.

Required preconditions to verify:
- Scheduled invocation is available on the deployment platform for the intended environment.
- A secret header value can be stored in environment variables without printing it.
- The endpoint is reachable and authenticated with least privilege only.

No scheduler is currently known to be configured in this project.

## Proposed schema (not implemented)

`game_pending_actions`:
- `id uuid primary key default gen_random_uuid()`
- `room_id uuid references rooms(id) on delete cascade`
- `round_number integer not null`
- `player_id uuid not null`
- `action_kind text not null` such as `hunter-final-shot`
- `expires_at timestamptz not null`
- `payload jsonb not null default '{}'::jsonb`
- `status text not null check (in pending, resolved, expired)`
- `resolved_at timestamptz`
- `resolution_token uuid not null` for idempotency
- unique constraint on room/round/player/action kind

RPCs (security-definer, service role only):
- `create_pending_action`
- `resolve_pending_action`
- `expire_pending_action`
- `list_overdue_pending_actions`

All writes require the `rooms` `for update` lock and must be transactional with normal game completion.

## Concurrency and authorization

- Authenticated user identity comes from the existing verified Supabase session.
- The eligible Hunter is resolved server-side from player data.
- Submission is idempotent by `resolution_token`.
- Resolution is atomic under the same transactional lock used by phase advancement.
- Win conditions are evaluated after resolution/chained effects, not before expiration.
- Public snapshots and Realtime payloads never include pending action details.

## Recovery flow

1. Scheduler invokes `/api/internal/pending-actions/finalize-expired` with a secret.
2. The handler authenticates the secret with `crypto.timingSafeEqual` or equivalent.
3. It loads overdue non-resolved rows under the room lock.
4. It resolves timeout outcomes and re-runs chained death/win checks.
5. The endpoint returns only count/status metadata.

## Platform and operational assumptions not verified

- Scheduled job frequency, timeout, deployment plan, and authentication header support must be manually checked.
- Whether Supabase or Vercel plan exposes the desired scheduler is not verified.
- Cron secrets must never be printed or committed.

## Hunter status

Hunter remains unimplemented and not active. This document is planning only.
