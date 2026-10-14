# Reference Repository Analysis & License Compliance

Reference: <https://github.com/GreyWolfDev/Werewolf> (C#/.NET + SQL Server Telegram bot)

## License determination

| Property | Finding |
| --- | --- |
| License | **GPL-3.0-only** (SPDX: `GPL-3.0`) |
| Evidence | `LICENSE.md` at repo root is the verbatim, unmodified FSF GPL-3.0 text (35,141 bytes). No project-specific header, no copyright line, **no "or later" clause** — so it is `-only`, not `-or-later`. |
| Corroboration | GitHub renders the repo as "GPL-3.0 license" in the sidebar. README carries no license section or extra badge. |
| Additional terms | **None.** No CLA, no commercial-use rider, no "contact the author" clause, no branding requirement. |

### What this means for this project

GPL-3.0 attaches to **the source code** of the reference project, not to the *rules of the game*.
Werewolf's rules, role concepts, phase ordering and win conditions are game mechanics — ideas,
methods and rules — which are not copyrightable subject matter.

Therefore:

- **This project is an independent, clean-room implementation.** No source code, assets,
  configuration, or text were copied or transliterated from the reference.
- Mechanics were *understood* and then re-expressed in idiomatic TypeScript/Postgres with a
  different architecture (transactional RPC-based state machine vs. a single-threaded
  `while` loop with `Thread.Sleep`).
- If GPL-3.0 derived code were ever added later, this whole repository would become
  GPL-3.0 and must be redistributed with source under that license. **Do not paste reference
  code into this repo.** The ADR-style note in `docs/IMPLEMENTATION-PLAN.md` ("License
  boundary") records this constraint.

No Telegram Bot API, .NET, or SQL Server dependency is present or planned.

---

## Mechanics studied, and what we deliberately did *not* copy

The reference implements **47 roles**. The MVP PRD scopes four. The table below records what we
took (concept level) and what we left, so future phases have a traceable basis.

### Roles in the reference (47) — grouped

- **Werewolf team (8):** Wolf, AlphaWolf, WolfCub, Lycan, Sorcerer, SnowWolf, Traitor
- **Village team (~32):** Villager, Drunk, Harlot, Seer, ApprenticeSeer, Beholder,
  GuardianAngel, Detective, Gunner, Mayor, Prince, Pacifist, Troublemaker, Blacksmith, Sandman,
  Mason, Hunter, WiseElder, ClumsyGuy, WildChild, Doppelgänger, Cupid, Fool, Oracle, Augur,
  Chemist, GraveDigger, CultistHunter, Spumpkin, Traitor, Sorcerer
- **Neutral / third-party (7):** Tanner, SerialKiller, Cultist, Thief, Arsonist, CultistHunter

### Roles we implement in the MVP (PRD §4)

| roleKey | alignment | nightAction | Source concept in reference |
| --- | --- | --- | --- |
| `werewolf` | `werewolf` | eliminate one target | Wolf |
| `villager` | `village` | none | Villager |
| `seer` | `village` | investigate target (private result) | Seer |
| `doctor` | `village` | protect target from elimination | GuardianAngel (protection only; no 50%-death, no multi-block) |

### Deliberately excluded from the MVP

Everything requiring extra state, extra rounds, or team logic beyond the PRD's two alignments:
Cupid/lovers, SnowWolf freeze, serial killer, cult, arsonist, tanner, hunter, gunner, mayor,
prince, masons, grave digger, chemist, thief, doppelgänger, wild child, sandman, blacksmith,
pacifist, troublemaker. The role registry is designed so these can be added without touching the
engine — see `src/lib/game/role-registry.ts`.

---

## Mechanic-by-mechanic: reference behavior vs. our decision

### 1. Night action resolution

**Reference.** A hard-coded, single-threaded sequence, documented in-code as
`SnowWolf → GraveDigger → Arsonist → Wolves → SK → CultistHunter → Cult → Chemist → Harlot →
Seer → Sorcerer → Fool → Oracle → Augur → GuardianAngel → Thief`. Notably, the Guardian Angel's
save is **hoisted to the top of the night cycle** and then checked *inside every attacker's
block*, so a single GA choice simultaneously blocks wolves, SK, freeze and fire. There is **no
per-target conflict resolver**; double-kills are prevented only implicitly because `IsDead` is
set synchronously by the earlier attacker and later attacks hit an `AlreadyDead` guard.

**Our decision.** Adopt the *protective* semantic (protection wins over elimination) but express
it as an explicit, declarative priority pipeline rather than an ordered function list:

1. Gather every submitted action for the round.
2. Apply **protection** effects first → produce a `protectedPlayerIds` set.
3. Apply **elimination** effects, skipping any target in `protectedPlayerIds`.
4. Apply **investigation** effects → produce **private** results (never public events).
5. Return results split into `public` / `private` / `internal` (PRD §16).

This keeps the reference's emergent outcome (doctor blocks wolf) while being unit-testable
without a running game, and without inheriting its "implicit AlreadyDead" coupling.

### 2. Action priority

Each role carries a numeric `actionPriority` in the registry. Higher priority resolves first.
MVP values are spaced to make new roles insertable:

| actionPriority | role | effect |
| --- | --- | --- |
| 300 | `seer` | information only, no world effect |
| 200 | `doctor` | protection |
| 100 | `werewolf` | elimination |

### 3. Self-targeting and repeat targeting

**Reference.** Every night action excludes self (`targetBase = Players.Where(x => !x.IsDead &&
x.Id != player.Id)`); the sole exception is Cupid. No cross-player uniqueness constraint — two
players may target the same person. Wolves get a second kill only when a WolfCub died, and that
second target must differ from the first. Per-role repeat limits exist for SnowWolf (cannot
freeze the same player twice in a row) and Arsonist (accumulates a doused list).

**Our decision.** MVP default: `canTargetSelf: false` for every role, with **no
override**. The reference has no self-targeting either, and the previous draft of
this repo carried an `allowSelfProtect` per-role config flag that the SQL never
read, so a setting existed that silently did nothing. It has been removed rather
than left as a misleading no-op. Re-enabling self-protection would be a new rule
and needs a PRD decision, not a config value. Cross-player duplicate
targets are **allowed** (they merge naturally in the effect sets). Same-player repeat across
rounds is **allowed** except where a role config sets `forbidRepeatTarget: true`. Both are
config-driven per role in `room_role_configs.config`, so a SnowWolf-style rule is a config
change plus a registry entry, not an engine change.

### 4. Voting resolution

**Reference.** Plurality. `maxVotes` → `choices`; if `choices.Count > 1` (a tie) then, with the
shipped default `RandomLynch = false`, **nobody is lynched** (`LynchTie`). All-zero votes →
nobody lynched. A revealed Mayor counts double. An AFK player who skips two consecutive lynch
rounds is idle-killed.

**Our decision.** Plurality, ties → no elimination by default, with `tieRule` configurable per
room (`'none' | 'random'`). Abstention = no `game_votes` row. Double-voting and idle-killing are
**not** implemented (out of MVP scope; noted here so it is a conscious omission, not an
oversight).

### 5. Win conditions

**Reference.** `CheckForGameEnd` is called ~8 times per phase, with a large number of
role-specific pre-checks (1–3 alive players produce bespoke outcomes: lovers win together, SK
wins at 2 alive, Tanner wins by being lynched, no-one wins in several 1/2/3-player states), then
the general parity rule:

```
count(wolves) >= count(everyone else)  ->  Wolf wins
no wolves remaining                    ->  Village wins
```

**Our decision.** Implement only the two standard alignments the PRD names, with the parity rule
expressed over alignment so it generalises:

- `werewolf` alignment wins when `aliveWerewolfCount >= aliveNonWerewolfCount` **and**
  `aliveWerewolfCount > 0`.
- `village` alignment wins when `aliveWerewolfCount == 0`.
- No "no one wins" states are reachable in the MVP (no serial killer, no lovers, no tanner).

Win checking runs **only** on the server, after night resolution and after vote elimination.

### 6. Phases and timers

**Reference.** `GameTime { Day, Lynch, Night }`, looping `NightCycle → DayCycle → LynchCycle`,
with `GameDay++` *before* the first night (so "day 1" means first night). Defaults: night 90s,
day 60s + scaling, lynch 90s. Menus **end early** once every pending prompt is answered.

**Our decision.** Five phases per the PRD state machine (`lobby → night → day → voting →
night`, `voting → finished`, `night → finished`). Early-exit "all answered" optimisation is
**not** implemented in the MVP (it complicates the deadline contract and is an optimisation, not
a rule). Deadlines are server-authoritative in `rooms.phase_ends_at`.

---

## Test cases derived from the reference

These behaviours are encoded as unit tests in `tests/unit/`:

| # | Behaviour | Test file |
| --- | --- | --- |
| 1 | Role distribution sums to player count | `role-assignment.test.ts` |
| 2 | Unregistered `roleKey` is rejected | `role-registry.test.ts` |
| 3 | Doctor protection blocks werewolf elimination | `night-resolution.test.ts` |
| 4 | Multiple votes for one target do not double-kill | `night-resolution.test.ts` |
| 5 | Investigation yields a private result, never a public event | `night-resolution.test.ts` |
| 6 | Absent night action = no effect (not a kill) | `night-resolution.test.ts` |
| 7 | Plurality vote tally | `vote-resolution.test.ts` |
| 8 | Tie → no elimination | `vote-resolution.test.ts` |
| 9 | Parity win, and village win | `win-condition.test.ts` |
| 10 | Villager cannot submit a night action | `action-validation.test.ts` |
