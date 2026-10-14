# Game Rules Specification (MVP)

Normative rules the engine implements. Where this document and
[`REFERENCE-ANALYSIS.md`](./REFERENCE-ANALYSIS.md) disagree, **this document wins**.

## 1. Alignment model

| Alignment | Members (MVP) | Win rule |
| --- | --- | --- |
| `werewolf` | `werewolf` | `aliveWerewolves >= aliveNonWerewolves` and `aliveWerewolves > 0` |
| `village` | `villager`, `seer`, `doctor` | `aliveWerewolves == 0` |
| `neutral` | *(none in MVP)* | reserved; a room whose config has **no** `werewolf` role is rejected |

Alignment — not role — drives win checking, so adding roles later cannot change win logic.

## 2. Roles

| roleKey | displayName | alignment | nightAction | actionPriority | notes |
| --- | --- | --- | --- | --- | --- |
| `werewolf` | Werewolf | `werewolf` | `eliminate` | 100 | Night kill, plurality across all living werewolves; **may not target another Werewolf** (§5) |
| `villager` | Villager | `village` | `null` | — | Discussion + voting only |
| `seer` | Seer | `village` | `investigate` | 300 | Learns the target's **alignment**; result is private to the seer |
| `doctor` | Doctor | `village` | `protect` | 200 | Protects target from night elimination; **may not protect another Doctor**, may not protect the same player two nights running (see §5) |

Adding a role = one entry in `src/lib/game/role-registry.ts`. No engine change.

## 3. Phase state machine

```
lobby ──start──▶ night ──deadline──▶ day ──deadline──▶ voting ──deadline──▶ night (round+1)
                                       │                    │
                                       │                    ├──▶ finished   (win condition met)
                                       └──(skip)──▶ night    └──▶ finished   (win condition met)
```

Legal transitions, enforced in `src/lib/game/phase-manager.ts`:

| From | To |
| --- | --- |
| `lobby` | `night` |
| `night` | `day`, `finished` |
| `day` | `voting` |
| `voting` | `night`, `finished` |

Anything else is a programming error and throws in the engine.

### Round numbering

`round_number` increments on each `lobby → night` and on each `voting → night`. A night, the
day that follows it, and the voting phase after that all share one round number. A game with
5 players therefore has `round_number: 1` through the first night, the first day **and** the
first voting phase, and `round_number: 2` from the second night onward. It matches the
reference's "day 1 == first night" convention.

## 4. Phase deadlines

- Every active phase stores `rooms.phase_ends_at` (`timestamptz`), set by the server only.
- The **browser clock is never authoritative**. The client countdown is display-only.
- After `phase_ends_at`, the server rejects new actions/votes for that phase (`409`).
- Players cannot extend deadlines.
- Default durations (overridable per room in `rooms.settings`, bounded by the schema):

| Phase | Default |
| --- | --- |
| night | 60 s |
| day (discussion) | 90 s |
| voting | 60 s |

## 5. Night phase

1. Player submits `actionType` + `targetPlayerId`.
2. Server validates, in this order:
   1. Authenticated session resolves to a `room_players` row in this room.
   2. Room `status = 'in_progress'` and `phase = 'night'`.
   3. `now() < phase_ends_at`.
   4. Player `is_alive`.
   5. Player's role has the requested `nightAction`.
   6. Target exists, is in the same room, and is alive.
   7. Role `targetRules` satisfied (self-targeting, same-role targeting, repeat-target).
      * **Same-role targeting (A1/A2).** A Werewolf may not eliminate another Werewolf, and a
        Doctor may not protect another Doctor. Enforced server-side from `player_secrets` on both
        sides, so a direct RPC caller cannot bypass it. A Seer **may** inspect another Seer.
        Rejections use the stable codes `target_is_werewolf` and `target_is_doctor`.

**Seer results when the target dies (A3).** The Seer always receives the target's alignment for
the round, even if the same night's resolution eliminates that target. The investigation is
resolved independently of the kill. The result is written privately, keyed to the acting
Seer's action and round, and is never published to the room, to `game_events`, or to another
player's `my-role` response.

**Repeat-target (Doctor).** A Doctor may not protect the same player in two *consecutive* rounds.
Round 1 has no predecessor, so any target is legal there. Protecting player A in round 1 and again
in round 3 is allowed — round 2 broke the streak. This is checked authoritatively inside
`submit_night_action` (migration `0007`), not only in the TypeScript validator, so a direct RPC
caller cannot bypass it. Re-submitting *within* the same round still replaces the prior action and is
never a repeat-target violation.
3. Upsert into `game_actions`, keyed by
   `(room_id, round_number, actor_player_id, action_type)` — so re-submitting **replaces** the
   prior action rather than adding a second one.
4. On deadline, resolution runs once, atomically (see §8).

**Rules with no submitted action are simply no-ops.** A doctor who does nothing protects nobody;
a werewolf team with no votes kills nobody. Absence of an action is never interpreted as an
attack on a default target.

## 6. Night resolution

Deterministic given a set of actions. Order is by `actionPriority` descending, then `actionType`
ascending, then `target_player_id` ascending — **never** by API request arrival order.

| Step | Effect class | Effect |
| --- | --- | --- |
| 1 | protection | `protectedIds` = targets of all valid `protect` actions |
| 2 | elimination | `killIds` = plurality-chosen targets of all `eliminate` actions, minus `protectedIds` |
| 3 | investigation | private result per valid `investigate` action |
| 4 | apply | `is_alive = false` for each `killIds` member; `kill_cause = 'night_elimination'` |

Cross-player duplicates collapse into a set: two independent werewolf kills on the same player
produce exactly one death. The final kill set is the *difference*, so a doctor-protected target
is never eliminated.

Werewolf target selection: plurality of the submitted `eliminate` actions across all living
werewolves. MVP tie-break is stable (lowest `seat_number` wins) — deterministic, which matters
for testability and for replay.

### Result separation (PRD §16)

The resolver returns three disjoint buckets:

- **public** — appended to `game_events.public_payload` (e.g. "Player X died tonight").
  **No role, no killer identity, no investigation target is ever included.**
- **private** — written to `game_action_results`, readable only via an endpoint that verifies
  the requesting player owns the action (e.g. seer's alignment result).
- **internal** — engine bookkeeping, never persisted.

## 7. Day phase

- All living players may read public information from the night (who died — not who or why).
- Text chat is optional and out of the critical path; if it is not implemented, discussion moves
  to an external voice/text channel and **the game loop is not blocked** (PRD §3.E).
- Dead players cannot send chat.
- On deadline → `voting`.

## 8. Voting (open)

- Only during `phase = 'voting'`.
- Only living players vote. Target must be living, in the same room, and not the voter.
- `game_votes` is unique on `(room_id, round_number, voter_player_id)` → re-submitting **updates**
  in place. One active vote per player per round, never two.
- Votes are **readable by all room members** (that is what "open" means), and targets must be in
  the same room.
- Resolution: plurality of `count(target_player_id)`.
  - `max == 0` or no rows → nobody eliminated.
  - exactly one target at max → eliminated, `kill_cause = 'vote_elimination'`.
  - tie → **nobody is eliminated**. This is the only MVP behaviour.

    The resolver (`src/lib/game/vote-resolution.ts`) accepts a `tieRule`
    parameter with `'none'` | `'random'`, and the random branch is unit-tested,
    but **no host setting selects it in the MVP**: there is no settings writer,
    and `phase-advancement.ts` calls `resolveVote` with the literal `'none'`.
    The knob was removed from `roomSettingsSchema` rather than left as an
    accepted-but-ignored option.

    Tie-breaking runs in the pure TypeScript engine with an injected RNG, not in
    SQL — an earlier revision of this document claimed `gen_random_uuid()` was
    used, which was never true.
- Win condition is checked after elimination.

## 9. Elimination

- Sets `is_alive = false`, `death_cause`, `died_at`.
- Prevents night actions, votes and (if implemented) chat.
- Emits a `player_eliminated` public event. The payload contains the **seat/display name** only.
- **Role reveal:** governed by the room setting `revealRoleOnElimination`, default `true`
  (standard party-game behaviour). When `false`, the role is withheld until the game finishes.

  The rule is a pure function, `isRoleRevealed` in `src/lib/game/reveal.ts`, evaluated at read
  time from authoritative state — no stored flag, no back-fill, and a settings change takes
  effect immediately for every client. It is surfaced as the nullable `revealedRole` field on
  each player in the public snapshot. The governing invariants:

  | game state | player alive | `revealedRole` |
  | --- | --- | --- |
  | in progress | yes | **always null, under every setting value** |
  | in progress | no | the role iff `revealRoleOnElimination !== false` |
  | finished | either | the role, unconditionally |

  The snapshot carries `role_key` only — never `alignment`, `private_state` or Seer results. A
  player's own role during an active game remains available exclusively through
  `GET /api/rooms/[roomId]/my-role`.

## 10. Win condition

Checked by the server only, immediately after night resolution and immediately after vote
elimination:

```
aliveWerewolves   = count(alive players with alignment 'werewolf')
aliveNonWerewolves = count(alive players with alignment <> 'werewolf')

if aliveWerewolves == 0                    -> village wins
if aliveWerewolves >= aliveNonWerewolves   -> werewolf wins   (and aliveWerewolves > 0)
```

If a winner is found: `status = 'finished'`, `phase = 'finished'`, `phase_ends_at = NULL`, a
`game_finished` public event is written, and **no further actions or transitions are accepted**.
All roles are then revealed publicly.

## 11. Configuration validation

`src/lib/game/role-registry.ts` + `validateRoleConfig` reject a room start unless **all** hold:

1. Every `roleKey` is registered in the engine.
2. Every `role_count` is an integer `>= 0`.
3. `sum(role_count) === playerCount`.
4. `playerCount` is within `[minPlayers, maxPlayers]`.
5. `playerCount >= 5` (`SETTINGS.gameplay.minStartablePlayers`; enforced identically by
   `validateRoleConfig`, the `start` route, the `start_game` RPC via migration
   `0008`, and the ready-to-start copy in the lobby UI, so the four cannot
   drift). Five is the smallest roster that gives the Seer and Doctor a partner
   and leaves the single Werewolf at least two Villagers to hide among.

   This minimum gates **starting** only. `join_room` does not enforce it, so a
   four-player lobby can always accept a fifth player — otherwise it could never
   become startable.

   A single Werewolf at five players is legal but produces a non-blocking
   warning: the wolf win condition is `aliveWerewolves >= aliveNonWerewolves`,
   so a lone wolf must survive to parity and one correct vote ends the game
   immediately.
6. At least **one** `werewolf` role (otherwise there is no way the werewolf side can win).
7. `werewolf` count `< playerCount` (otherwise village can never win).
8. Every per-role `config` object parses against that role's `configSchema`.
9. `playerCount > 1` (a 1-player room is not a game).

A rejected configuration returns `400` with a field-level error list. Configuration is **locked**
at start: `rooms.settings` and `room_role_configs` are not writable after `status != 'lobby'`.

**No per-role configuration.** The MVP accepts an empty `config: {}` for every role and applies
no per-role options. Two options that used to exist were removed because they were accepted and
persisted but had no runtime effect — a host could switch them on and the game would not change:

* Werewolf `requireUnanimous` — the kill is always resolved by plurality with a lowest-seat
  tie-break (§6). "Unanimous" was never consulted.
* Seer `reveal: 'role' | 'alignment'` — the Seer has only ever reported **alignment**; `'role'`
  was silently ignored.

Sending either option now fails validation with a field-level "unrecognized key" error. This is
deliberate: an option that silently does nothing is worse than no option.

## 12. Identity and authority (non-negotiable)

- Player identity comes **only** from the verified Supabase auth session.
- No endpoint ever accepts `user_id` or `player_id` from a request body as authorization.
- The host is an ordinary player: **no endpoint grants the host visibility into other players'
  roles or actions.**
- `player_secrets` and `game_actions` have **no** client-readable RLS policy. They are reachable
  only through server code using the service-role key, after an ownership check.
- The browser is never trusted for game state, role assignment, deadlines, or results.

## 13. What is deliberately out of scope

Not implemented in the MVP, by design: voice/video chat, spectators, lovers, serial killer,
cult, arsonist, hunter/gunner mayor-double-vote, idle-kill for AFK players, role conversion or
role mutation mid-game, early phase exit when all actions are submitted.
