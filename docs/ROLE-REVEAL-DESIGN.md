# Role Reveal — design + implementation record

Status: **IMPLEMENTED as Option B (derive from authoritative state).** No
migration, no column, no RLS policy was added. The design below is retained
because it explains *why* the derivation is preferred over a stored flag.

Implementation:
- `src/lib/game/reveal.ts` — the pure rule (`isRoleRevealed`).
- `src/app/api/rooms/[roomId]/route.ts` — projects `revealedRole` per player.
- `src/lib/game/safe-room.ts` — the field on `SafePlayer`.
- `tests/unit/role-reveal.test.ts` — 18 cases over the (status, alive, setting)
  truth table, with the living-player invariant asserted under every setting.

**One deviation from the original proposal, recorded deliberately.** Section 4
suggested the snapshot route could read `player_secrets` with "the service role".
Section 5 also asserted RLS on `player_secrets` has zero policies — which is
true, and is exactly why the caller's *session* client reads nothing there and
every `revealedRole` came back null. The service-role read is therefore
required, scoped to `player_id in (this room's roster ids)`, and selecting
`role_key` alone. `tests/security/role-privacy.test.ts` pins all three of those
constraints. See the final report for the trade-off.

Source rules:

- `GAME-RULES.md` §9 — "Role reveal: governed by room setting
  `reveal_role_on_elimination`, default `true` (standard party-game behaviour, and
  the MVP game page shows it). When `false`, the role is withheld until the game
  finishes."
- `GAME-RULES.md` §10 — "All roles are then revealed publicly."
- `GAME-RULES.md` §12 / §6 — living players' roles and Seer results are private
  at all times. Reveal is a *post-elimination* / *terminal* disclosure, never a
  peek at a living player.

---

## 1. Requirement restated

Two distinct disclosures:

| Trigger | Scope | Condition |
| --- | --- | --- |
| Elimination (night kill or lynching) | the eliminated player only | `reveal_role_on_elimination === true` |
| Game finished | **every** player | always |

Until a game is finished, a living player's role must remain unreadable through
any public surface.

---

## 2. Options considered

### Option A — `room_players.role_revealed_at timestamptz`

Add a nullable column; a player is revealed once the column is non-null.

- **Pro:** the reveal decision is stored next to the data it describes, so the
  snapshot projection is a single predicate (`role_revealed_at is not null`).
- **Con:** it duplicates state that is already derivable. `is_alive = false` plus
  the room setting determines reveal, and the room setting can change while the
  game runs — the column would have to be back-filled or cleared when it does.
  Two sources of truth that can disagree.

### Option B — derive from authoritative state (RECOMMENDED)

No new column. Reveal is a **pure function** of state the database already owns:

```
isRevealed(player) =
      room.status = 'finished'                              -- terminal: reveal everyone
   OR (room.settings->>'revealRoleOnElimination') IS DISTINCT FROM 'false'
      AND player.is_alive = false                          -- elimination: reveal the dead
```

- **Pro:** no schema change, no back-fill, no drift. The rule is stated once and
  evaluated at read time, so a setting change takes effect immediately and
  consistently for every client.
- **Pro:** identical logic is already used by the pure engine
  (`evaluateWinCondition` etc.), which matches the project's stated architecture:
  "Business logic lives in `src/lib/game/*` as pure, testable modules."
- **Con:** the snapshot route must read `settings` and join `player_secrets` to
  decide what to emit — but that read already happens server-side with the
  service role, and only the *revealed* subset is ever projected out.

### Option C — derive from `game_events`

`player_eliminated` payloads would carry the role.

- **Con: rejected.** `game_events` is member-readable and **append-only**. Baking a
  role into a public event makes the disclosure irreversible: if the host sets
  `revealRoleOnElimination: false` mid-game, previously-written events still
  carry the role. It also widens the blast radius of the most-read table.

**Recommendation: Option B.**

---

## 3. Proposed public snapshot contract

`GET /api/rooms/[roomId]` gains exactly one field, and only ever for players
who are already entitled to it:

```ts
players: Array<{
  // ...unchanged public fields...
  /**
   * The role of an ELIMINATED player, when the room's reveal rule permits it.
   * null for every living player, always — including at game start, during the
   * night phase, and for the caller themself.
   */
  revealedRole: 'werewolf' | 'villager' | 'seer' | 'guardian_angel' | null;
}>
```

Explicit invariants:

1. `revealedRole === null` for **every** living player while
   `status = 'in_progress'`. There is no configuration that changes this.
2. For a dead player, non-null iff `revealRoleOnElimination !== false`.
3. When `status = 'finished'`, non-null for **all** players, living and dead.
4. The field carries **only** `role_key`. Never `alignment`, never
   `player_secrets.private_state`, never anything from `game_action_results`.
5. The caller's own role is still **not** in the snapshot — it continues to come
   from `GET /api/rooms/[roomId]/my-role`, which is the only role-bearing read
   and is already ownership-checked.

Invariants 1–3 are the security property. Invariant 5 is why this is a small,
additive change rather than a widening of an existing endpoint.

---

## 4. Affected surfaces

| Surface | Change |
| --- | --- |
| `src/lib/game/reveal.ts` (new) | Pure `isRoleRevealed({ roomStatus, revealSetting, isAlive })` + unit tests. Single source of truth. |
| `src/app/api/rooms/[roomId]/route.ts` | Join `player_secrets` **by the room's player ids only** (same scoping discipline as `phase-advancement.ts`), and project `revealedRole` per the pure rule. |
| `src/app/rooms/[roomId]/page.tsx` | Render a revealed role badge on dead rows and in the Game Over roster. Presentation only. |
| `src/types/database.ts` | No change — `revealedRole` is a computed projection, not a column. |
| `src/lib/game/settings.ts` | `defaultRevealRoleOnElimination: true` already exists; wire it to the snapshot read. |
| `src/lib/schemas/game.ts` | `revealRoleOnElimination` already exists and is unused; it becomes live. |

**Migration required: none.**

---

## 5. Why `player_secrets` stays untouched

The snapshot route would read `player_secrets` with the service role, which is
already how `my-role` works. The safety properties that matter:

- RLS on `player_secrets` still has **zero policies**, so no client can reach it.
  This change does not add one.
- The read is scoped to `player_id in (room's roster)` — never a whole-table
  read.
- Only `role_key` is projected, and only for players the pure rule has already
  declared revealable. A bug that flipped `isAlive` to `true` in the rule would
  be caught by the rule's unit tests, which is why the rule is a separate pure
  module rather than inline SQL.

---

## 6. Proposed tests

Unit (`src/lib/game/reveal.ts`, no DB):

- living + in_progress + reveal=true → `false`
- dead + in_progress + reveal=true → `true`
- dead + in_progress + reveal=false → `false`
- living + in_progress + reveal=false → `false`
- any + finished → `true` (living and dead alike)
- missing/garbage setting → defaults to `true` (setting absent means default on)

SQL (`supabase/tests/gameplay.sql`, real Postgres):

- dead player is revealed in the snapshot projection with `revealRoleOnElimination` unset
- living players are never revealed mid-game even with the setting on
- a dead player is **not** revealed when the setting is explicitly `false`
- every player is revealed once `status = 'finished'`
- no `alignment`, `private_state`, or Seer payload appears in the projected rows

Route (`tests/security/`):

- `revealedRole` is `null` for every player in a live game
- the snapshot never contains any key from the private secret tables for a
  living player
- `my-role` behaviour is unchanged

---

## 7. Resolved questions (approved)

1. **Setting name — RESOLVED: camelCase `revealRoleOnElimination`.** The docs said `reveal_role_on_elimination` (snake_case);
   `src/lib/schemas/game.ts` uses `revealRoleOnElimination` (camelCase) because
   the settings JSON is already camelCase (`voteTieRule`, `phaseSeconds`).
   GAME-RULES.md now documents the camelCase spelling.
2. **Reveal at finish, including the caller — RESOLVED: yes.** §10 is
   unconditional. The caller's own role during the game still comes only from
   `my-role`.
3. **Does a finished room need the setting to have been on? — RESOLVED: no.**
   The `finished` branch is evaluated first in `isRoleRevealed` and returns true
   before the setting is consulted at all.
4. **Host settings UI — RESOLVED: deferred.** Nothing in the MVP writes
   `revealRoleOnElimination`, so the default (`true`) is the only live path.
   `voteTieRule` was removed from `roomSettingsSchema` rather than left as an
   accepted-but-ignored option.
---

## 8. Open follow-up: `leave_room` and departure semantics

**Status: documented, NOT implemented. No endpoint exists for this today.**

Recorded here because role reveal now makes a pre-existing behaviour observable,
and it should be decided before anyone adds a leave feature.

`public.leave_room(p_room_id, p_user_id)` has a mid-game branch that does:

```sql
update public.room_players
   set is_alive = false,
       death_cause = 'vote_elimination',
       died_at = now()
 where id = v_player.id;
```

`isRoleRevealed` keys **only** off `is_alive` (plus room status and the reveal
setting). So the moment a player disconnects through this path:

1. **Their role becomes publicly visible.** They are treated exactly like a player
   who was lynched, so `revealedRole` is populated for them mid-game.
2. **The death cause is factually wrong.** They were not voted out; the UI renders
   this as "Lynched" (`page.tsx`, the `deathCause` branch).
3. **A `player_eliminated` event is emitted** with `reason: 'left_game'`, so the
   event stream and the roster disagree about what happened.

Whether that is *wrong* is a rules question, not a bug:

- It is defensible for a game where departure should not be a hiding place, and
  `leave_room` clearly intends the player to stay on the board ("marked dead
  rather than deleted, so votes, actions and event history stay intact").
- It is surprising if departure is meant to be quiet, and it is certainly
  surprising that the reported cause is a lie.

**Requirement before a leave-room endpoint is added:** decide and document
whether a departure is a revealable elimination. If it should be treated
distinctly, the rule needs a new input (a departure marker distinct from
`death_cause`) rather than overloading `is_alive`; if it should stay as-is, the
UI copy and the `death_cause` value should be corrected so the roster does not
claim someone was lynched when they left.

Neither option requires a schema change today, because the RPC is unreachable —
`leave_room` is referenced only by the generated type in
`src/types/database.ts`, with no route that calls it.
