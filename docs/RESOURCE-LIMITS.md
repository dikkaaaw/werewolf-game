# Resource Limits, Free-Tier Behaviour & Retention

**These are internal MVP defaults, not Vercel or Supabase quotas.** Provider quotas change
independently of this app and must be re-checked before deploying. Application limits reduce
abuse risk and runaway cost; they do **not** guarantee you will never be billed or throttled.

Every value below is a constant in `src/lib/game/settings.ts`. Change it there, not in handlers.

## 1. Room limits

| Limit | Default | Where enforced |
| --- | --- | --- |
| Max players per room | 20 | `createRoomSchema`, DB `max_players` check |
| Min players to start | 4 | `validateRoleConfig` |
| Max players per room in DB | 20 | `rooms_max_players_check` |
| Rooms created per account | 3 / hour | `rateLimit('create_room')` |
| Concurrent active rooms per account | 5 | `countActiveRoomsForUser` |
| Lobby expiry (no activity) | 2 hours | `rooms.expires_at` |
| Finished-room retention | 24 hours | `rooms.expires_at` pushed on finish |
| Room code alphabet | `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` | 31 symbols, no `I/O/0/1` |
| Room code length | 6 chars | 31⁶ ≈ 887M codes, with a unique constraint |

Room codes are random (not sequential), so guessing one is ~1-in-887M per attempt — which is why
join attempts are also rate limited (§2).

## 2. Rate limits (database-backed)

Counters live in `rate_limit_counters`, incremented with a single atomic `INSERT … ON CONFLICT
DO UPDATE`. **Not** in process memory: Vercel runs many instances and memory counters would each
be independent, letting an attacker multiply their quota by instance count.

| Endpoint | Default |
| --- | --- |
| Create room | 3 / hour / account |
| Join room | 10 / minute / account |
| Submit night action | 10 / minute / account |
| Submit vote | 10 / minute / account |
| Read room snapshot | 60 / minute / account |
| Internal scheduler | *(planned only — no internal endpoint exists yet, see §8)* |

Failed requests count too — otherwise guessing room codes is unthrottled by design.

**Counter retention.** Rows older than the longest window (1 hour) are deleted opportunistically
by the cleanup job in bounded batches. We store one row per (bucket, key, window), never one row
per request.

**Anonymous auth abuse.** The per-account limits above do not stop someone minting many accounts.
Complementary measures: join is limited per account *and* the room code is high-entropy; chat is
out of the MVP critical path. CAPTCHA / email verification is the correct next control if abuse
is observed in production, and is called out in §8.

## 3. Phase durations and retention

| Phase | Default |
| --- | --- |
| night | 60 s |
| day | 90 s |
| voting | 60 s |

Bounded range in the schema: night 15–300 s, day 15–600 s, voting 15–300 s.

| Data | Retention |
| --- | --- |
| Lobby rooms | expire 2 h after last activity |
| Finished rooms | 24 h after finish |
| `game_events`, `game_actions`, `game_votes`, `game_action_results`, chat | cascade-deleted with the room |
| `rate_limit_counters` | 1 h |
| `game_audit_logs` | 7 days |

Room deletion **cascades** to `room_players → player_secrets`, `room_role_configs`,
`game_actions`, `game_votes`, `game_events`, `game_chat_messages`,
`game_action_results`, `game_audit_logs` (PRD §18.D).

## 4. Cleanup job

**Not implemented.** There is no `src/app/api/internal/` directory, so the planned
secret-authenticated `POST /api/internal/cleanup` endpoint does not exist and nothing
performs these sweeps today. It is specified here so the behaviour is unambiguous when it
is built:

1. Expire idle lobbies (`status='lobby' AND last_activity_at < now() - 2h`).
2. Expire finished rooms past retention.
3. Delete expired rooms **in bounded batches** (`LIMIT 50` per run) so it never locks a large
   portion of the table at once, and so a partial failure is simply resumed next run.
4. Purge stale `rate_limit_counters` and `game_audit_logs`.
5. **Never** touches a room that is `in_progress`.

It is safe to run repeatedly and concurrently with live traffic.

Because the job does not run, `rate_limit_counters` and `game_audit_logs` rows are
currently only ever added. See §9.

## 5. Payload and storage limits

- **No file uploads.** No images, audio or video are stored on Supabase Storage in the MVP.
- Request body cap **16 KB**, enforced in the API helper before parsing.
- `display_name` 2–24 chars; chat message 1–500 chars; settings JSON depth/size bounded by Zod.
- Game state is stored relationally, **not** as one large `JSONB` blob, so it is queryable and
  individually indexable.
- Raw request payloads are never persisted.
- Public event history is **paginated** (default 50, max 200) — the full log is never shipped to
  every client.
- Derived values are recomputed rather than stored (e.g. alive counts are computed, not cached).

## 6. Realtime usage

- Subscriptions are created **once** per room view, in a single hook, and unsubscribed on unmount
  and on room change — never one subscription per component render.
- Only public tables are added to the `supabase_realtime` publication:
  `rooms`, `room_players`, `game_votes`, `game_events`.
  **`player_secrets`, `game_actions`, `game_action_results` are never published.**
- **No timer broadcasts.** The countdown is computed client-side from `phase_ends_at`. Nothing
  pushes a tick every second.
- Clients re-fetch the authoritative snapshot on reconnect; missed events are tolerated by
  design, since Realtime is a sync mechanism and **not** the source of truth.

## 7. Monitoring checklist (manual, pre-production)

- [ ] Database size growth rate
- [ ] Egress bytes
- [ ] Realtime messages/month
- [ ] MAU and function invocation counts
- [ ] API request rate **and error rate**
- [ ] Active rooms and rooms stuck past deadline (a proxy for a dead scheduler)
- [ ] Count of un-deleted expired rooms (a proxy for a cleanup job that never ran)

Suggested internal safety thresholds — exceed these, log loudly and consider throttling room
creation while letting in-progress games finish:

| Signal | Threshold |
| --- | --- |
| Expired rooms not yet collected | > 200 |
| Active rooms past deadline > 2 min | > 20 |
| 5xx rate over 15 min | > 2 % |
| DB size | > 80 % of plan quota |

## 8. Scheduler truthfulness

**This is the most important limitation in this document.**

**What actually ships today: lazy advancement, and nothing else.** No scheduler of any kind
is configured, deployed or verified, and there is no endpoint for one to call —
`POST /api/internal/advance-phases` **does not exist** (`src/app/api/internal/` is absent
from the tree). Building that endpoint is outstanding work.

- **Vercel Hobby Cron can fire at most once per day.** It cannot drive per-minute phase
  transitions. We do not pretend otherwise and we do not depend on it.
- **Lazy advancement is the only trigger in the code.** `GET /api/rooms/{id}`,
  `POST .../actions` and `POST .../votes` call `advanceRoomPhaseIfExpired(roomId)`
  (`src/lib/server/phase-advancement.ts`), which claims and resolves any overdue transition
  before serving the request. A room with zero traffic can therefore sit past its deadline
  indefinitely. The UI must not display a claim that the game is running on a precise
  schedule; it shows the server's `phase_ends_at` and says the game may advance on the next
  player action.
- **To get on-time transitions**, two things have to be built first: a secret-authenticated
  internal endpoint for a scheduler to call, then a Supabase `pg_cron` (or other sub-daily
  scheduler) pointed at it on a 10–30 s interval. Neither step has been taken.
- **If on-time advancement is a hard requirement, provision a real scheduler before production.**
  This is a deployment prerequisite, not a code change.

## 9. Known gaps

- **No `/api/internal/*` endpoints.** Neither the scheduler trigger nor the cleanup sweep is
  built, so phases advance lazily (§8) and retention/counter cleanup never runs (§4).
- No CAPTCHA / email verification — add before public launch if abuse appears.
- No media upload (deliberate).
- No AFK idle-kill (deliberate; see `GAME-RULES.md` §8).
- `rate_limit_counters` and `game_audit_logs` rows are only ever added today. The cleanup job
  that would delete them does not exist yet, so they grow slowly and are still correct, just
  larger.
