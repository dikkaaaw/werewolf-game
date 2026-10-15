# Role Specification (Stage A Inventory)

Reference: GreyWolfDev/Werewolf (concept-level only; no source code copied).  
Local assets: `public/assets/images/role-character/*.jpg`.

## Scope

This document inventories the reference role catalog and local prepared assets before further gameplay expansion. It introduces no behavior changes by itself.

## Currently implemented roles

| Internal role ID | Display name | Alignment | Asset path | Status |
| --- | --- | --- | --- | --- |
| `werewolf` | Werewolf | werewolf | `/assets/images/role-character/werewolf.jpg` | Implemented |
| `villager` | Villager | village | `/assets/images/role-character/villager.jpg` | Implemented |
| `seer` | Seer | village | `/assets/images/role-character/seer.jpg` | Implemented |
| `guardian_angel` | Guardian Angel | village | `/assets/images/role-character/guardian_angel.jpg` | Implemented |

## Reference roles grouped in the reference implementation

The 47 reference roles identified in `docs/REFERENCE-ANALYSIS.md` are grouped as:

- **Werewolf team (8):** Wolf, AlphaWolf, WolfCub, Lycan, Sorcerer, SnowWolf, Traitor
- **Village team:** Beholder, Blacksmith, Chemist, ClumsyGuy, Cupid, Doppelgänger, Drunk, Fool, GraveDigger, GuardianAngel, Gunner, Harlot, Hunter, Mason, Mayor, Oracle/Augur, Pacifist, Prince, Sandman, Seer/ApprenticeSeer, Spumpkin, Troublemaker, Villager, WildChild, WiseElder
- **Neutral / third-party (7):** Arsonist, Cultist, CultistHunter, SerialKiller, Tanner, Thief

Counts and naming are reference summaries only; exact mechanics require source-level inspection.

## Local asset inventory and provisional role mapping

| Asset filename | Provisional role mapping | Implementation status |
| --- | --- | --- |
| `alpha_wolf.jpg` | Alpha Wolf | Not implemented |
| `arsonist.jpg` | Arsonist | Not implemented |
| `beholder.jpg` | Beholder | Not implemented |
| `cultist.jpg` | Cultist | Not implemented |
| `cultist_hunter.jpg` | Cultist Hunter | Not implemented |
| `cupid.jpg` | Cupid | Not implemented |
| `cursed.jpg` | Cursed | Not implemented (reference name not in current inventory) |
| `detective.jpg` | Detective | Not implemented |
| `doppleganger.jpg` | Doppelgänger | Not implemented |
| `drunkman.jpg` | Drunk | Not implemented |
| `fool.jpg` | Fool | Not implemented |
| `guardian_angel.jpg` | Guardian Angel / Doctor | Doctor maps to this artwork |
| `harlot.jpg` | Harlot | Not implemented |
| `hunter.jpg` | Hunter | Not implemented |
| `lycan.jpg` | Lycan | Not implemented |
| `mason.jpg` | Mason | Not implemented |
| `mayor.jpg` | Mayor | Not implemented |
| `oracle.jpg` | Oracle/Augur | Not implemented |
| `prince.jpg` | Prince | Not implemented |
| `seer.jpg` | Seer | Implemented |
| `serial_killer.jpg` | Serial Killer | Not implemented |
| `sorcerer.jpg` | Sorcerer | Not implemented |
| `tanner.jpg` | Tanner | Not implemented |
| `thief.jpg` | Thief | Not implemented |
| `troublemaker.jpg` | Troublemaker | Not implemented |
| `villager.jpg` | Villager | Implemented |
| `werewolf.jpg` | Werewolf | Implemented |
| `wolf_cub.jpg` | Wolf Cub | Not implemented |
| `wolfman.jpg` | Wolfman | Not implemented |

Assets and registry entries must be added together. The registry remains the single authoritative source for selectable roles.

## Common mechanics that must be preserved

- Minimum 5 players.
- Host-only Start Game.
- All players must be ready before starting.
- Rooms remain lobby-only for Game Settings editing.
- `rooms.settings` and `room_role_configs` keep their current persistence model.
- Werewolves cannot target another Werewolf.
- Guardian Angels cannot protect another Guardian Angel.
- The Seer reports private alignment.
- Guardian Angel protection blocks a single-night elimination.
- Server-side identity and authorization remain authoritative.

## Lycan (verified Stage C1, not implemented)
Status: Research-complete for mechanics; implementation remains NOT APPROVED.

### Stage C2 unresolved decisions

1. Seer alignment-mapping decision:
   - Reference evidence: `Werewolf Node/Werewolf.cs`, lines 3881–3884:
     ```cs
     case IRole.Lycan: //sneaky wuff
         role = IRole.Villager;
         break;
     ```
   - Reference Seer behavior reports exact role `Villager` for Lycan.
   - Current project Seer contract (role registry and `resolveNight`) produces `targetAlignment` only, not exact role. For a Lycan whose internal alignment is `werewolf`, the current Seer would report `werewolf`.
   - Conflict: reproducing the reference requires a role-specific investigation override returning `village` for Lycan. This changes both a gameplay outcome and the existing role-neutral Seer abstraction.
   - Recommended policy pending approval: keep Seer role-neutral unless explicitly approved; if approved, implement a special `investigate` outcome for `lycan` that produces `village`, with role identity separately preserved as `lycan`.
   - Implementation consequence: `role registry` needs an explicit role-specific investigation override; night resolution must return a special `targetAlignment` without mutating the Seer's ability or exposing Lycan's actual alignment elsewhere.

2. Transformation decision:
   - Reference evidence searched in `Werewolf Node/Werewolf.cs`. `Lycan` appears in transformation target sets, not as an autonomous transformation trigger:
     - line 2117/2141 (Doppelgänger transformation cases)
     - lines 2159/2160 same section, only when another role becomes Lycan.
   - No reference line shows Lycan automatically transforming at night, on death, on survival, or at role transition.
   - Conclusion: Lycan itself does not have an autonomous transformation mechanic in the reference.
   - Any Doppelgänger or external transformation target behavior requires separate, role-specific design before implementation; do not implement it as Lycan logic.



Reference evidence:
- `Shared/Roles.cs`: `Lycan = 1073741824`
- `Werewolf Node/Werewolf.cs`: line 48 — `WolfRoles` includes `IRole.Lycan`; line 1591 — `ITeam.Wolf`; lines 3881–3884 — Seer sees `IRole.Lycan` as `IRole.Villager` ("sneaky wuff"); line 2939 — `IRole.Lycan` is included in the bad-role group used for wolf target eligibility; line 4310/4573 public death display groups Lycan with wolves; line 4331 Guardian Angel protecting a wolf prints `GuardWolf`.

Verified mechanics:
- Team/alignment: Wolf team (`ITeam.Wolf`), counts for wolf win.
- Win condition: same parity rule as wolves; win when wolves equal/outnumber non-wolves (MVP simplified rule).
- Night action: no night action.
- Werewolf attack behavior: Lycan is counted among wolves and is not targeted by wolves via `WolfRoles`.
- Guardian Angel behavior: protected as a wolf from external attacks; no distinct role-specific protection exception.
- Seer investigation result: Lycan is falsely reported as `Villager`.
- Voting/death: otherwise behaves as a wolf in public death announcements.
- Special interaction: role transformation paths such as Doppelgänger/DirectlyConvert may treat Lycan as a wolf; this is reference-specific and needs specific future design if implemented.

Unresolved ambiguities:
- No independent Lycan night action exists, so there is no action-validation policy to document beyond standard wolf-team membership.
- Existing MVP Seer returns alignment, not exact role. The reference reports Lycan as `Villager`, which corresponds to `village` alignment in this project. Implementation must test this mapping rather than assume exact-role disclosure.

Implementation status: Not implemented and intentionally not registered.

**Stage C2 verdict: NOT READY for implementation until the Seer policy decision above is explicitly approved.**

## Hunter (verified Stage D1, not implemented)

Reference evidence:
- `Shared/Roles.cs`: enum value `Hunter`.
- `Werewolf Node/Werewolf.cs`, line 5582: `KillPlayer(... hunterFinalShot: bool = true ...)`.
- `Werewolf Node/Werewolf.cs`, line 5624: `case IRole.Hunter: if (killMethod.HasValue && hunterFinalShot) HunterFinalShot(p, killMethod.Value, delay: isNight);`.
- `Werewolf Node/Werewolf.cs`, line 5420: `HunterFinalShot(IPlayer hunter, KillMthd method, bool delay = false)` raises hunter from dead, presents a live 30-second menu to alive targets or Skip, then re-kills hunter. Death caused is `KillMthd.HunterKill` (or `KillMthd.HunterShot`/`HunterCult` for attacker-triggered mechanics elsewhere).
- `Werewolf Node/Werewolf.cs`, lines 4420–4424: FinalShotDelay (from earlier delayed night death) is processed after night notification, then `HunterFinalShot(h.Key, h.Value)` runs.
- `Werewolf Node/Werewolf.cs`, lines 3325–3370: Wolf attack against a target with `HasShotHunterAttacker >= 2` can transform into killing the attacking wolves (`ShotKill` after a repeated attack).
- `Werewolf Node/Werewolf.cs`, lines 3569–3641: Cult conversion interaction with Hunter (`hunterFinalShot` / `HasShotHunterAttacker`).
- `Werewolf Node/Werewolf.cs`, lines 4194–4210: lover death may defer a hunter's own final shot via `FinalShotDelay`.

Verified mechanics:
- Hunter has no night action; its ability is post-death and triggered by the Hunter's own death, unless the kill call explicitly passes `hunterFinalShot: false`.
- The trigger is role-based and optional by caller: some kills disable the shot (e.g. some special-role kills).
- The target menu is shown while Hunter is artificially restored as alive and allows selecting any currently alive player or Skip.
- The final shot resolves synchronously in a 30-second window and immediately kills the chosen target with a Hunter kill method.

Unresolved ambiguities:
- The reference defers only part of the final shot with `FinalShotDelay = method`, but the exact integration with this project's timed night/deadline model is not yet designed.
- Interaction with game-over checks and simultaneous lovers' deaths must be defined because `HunterFinalShot` temporarily resurrects a dead Hunter.
- `HasShotHunterAttacker` special repeated-attack behavior is an attacker-facing mechanic; its exact target-eligibility and counter rules are not yet specified in sufficient detail for implementation.
- It is not yet verified how a public death announcement and win check interleave with the delayed final shot.

Implementation readiness: NOT READY. Requires a post-death action hook and an explicit timing policy before role registration.

### Hunter trigger matrix (Stage D3)

Reference commit `ca547ccb`. Trigger runs in `KillPlayer` at `Werewolf.cs:5624` only when `killMethod.HasValue && hunterFinalShot`. The `hunterFinalShot` parameter defaults to `true`; several call sites explicitly pass `false`.

| Death cause | Source evidence | Trigger | Selection | Resolution |
| --- | --- | --- | --- | --- |
| Default-eligible kill | Most `KillPlayer` calls where `hunterFinalShot` is not explicitly false | Immediate `HunterFinalShot(method)`; night kills set `FinalShotDelay` and defer the menu to post-night processing | 30 sec, alive targets or Skip | Final shot kill immediately; chained deaths resolve before win checks |
| Wolf eat, first wolf target | `Werewolf.cs:3311` | Trigger when Hunter killed by wolf hunt | 30 sec | As above |
| Wolf eat, repeated wolf target | `Werewolf.cs:3367`, `:3428` | `hunterFinalShot: false`; no shot | none | Normal death only |
| Hunter Shot | `Werewolf.cs:3370` | Trigger when a wolf shot-event kills Hunter | 30 sec | As above |
| Hunter Cult | `Werewolf.cs:3637` | Trigger when cult conversion kills Hunter | 30 sec | As above |
| Lynch | `Werewolf.cs:2766` | Trigger when Hunter is lynched | 30 sec | Post-shot effects then win check |
| Burn | `Werewolf.cs:3199` | false | none | Normal death and arsonist notification |
| FallGrave | `Werewolf.cs:2393` | false | none | Normal death |
| Idle | `Werewolf.cs:2682` | false | none | Normal death |
| Flee | `Werewolf.cs:5376` | false | none | Normal death |
| Serial Killer direct hunter kill | `Werewolf.cs:4893` | false | none | Normal death |
| SK/Wolf endgame shot | `Werewolf.cs:4545` | Hunter shooting another; no extra trigger? | Unlike night death, the Hunter chooses target immediately and `KillPlayer` runs immediately | As above |
| Lover death | `Werewolf.cs:4207`, `5612` | Conditional/project-specific; if the Hunter has a special kill method, chained consequences run | deferred | Requires destination-role-specific handling |

Unresolved trigger matrix details remain: exact behavior for Gunner, Cult/Mason, Harlot, and lover chains where `hunterFinalShot` differs by branch. These need precise path-by-path review before implementation.

### Verified timing and win-check semantics (Stage D2)

Verified reference behavior from commit `ca547ccb`:
- `KillPlayer` performs the Hunter branch synchronously and calls `HunterFinalShot(..., delay: isNight)`.
- If `killMethod.HasValue && hunterFinalShot` is false, no Hunter shot is scheduled.
- At night, `HunterFinalShot` is deferred through `FinalShotDelay`; a nighttime Hunter kill does not begin menu selection until the game loop reaches `hunterFinalShot` processing, after nightly death notifications.
- In both night and daytime paths, the Hunter menu blocks the caller for exactly 30 seconds while the player chooses or times out.
- The final shot re-kills the Hunter's target immediately, then normal `KillPlayer` logic resolves chained effects.
- Night processing calls `CheckForGameEnd()` after the final-shot dictionary has been processed.
- In the daytime lynch path, `CheckForGameEnd(true)` is called after the existing lynchkill/final-shot effects.
- Therefore game completion is never evaluated before the Hunter shot or before its chained deaths.

Project-specific timing policy:
- Do not reproduce the reference's blocking 30-second server thread. Represent a Hunter shot as a persisted pending action with its own deadline/selection state.
- Nightly deaths may defer it through `FinalShotDelay`; while that is pending, the room should not finish even if wolf/village win thresholds are already met.
- After the target is selected or the Hunter deadline expires, resolve the chained death and win check; only then advance phases.
- A Hunter who dies and later times out or disconnects produces no final shot and returns to elimination, after which normal win checks resolve.
- Concurrent phase-advancement claims must preserve this order.

Unresolved behavior:
- The reference only appears to offer the final shot on some kill paths (`hunterFinalShot` boolean), so the exact method/trigger matrix still needs exact documentation before implementation.



### Hunter source trace (Stage E6, not implementation)

| Trigger | Source call chain | `hunterFinalShot` behavior | Timing | Death chaining | Win check |
| --- | --- | --- | --- | --- | --- |
| Night death of a Hunter | `KillPlayer` (`Werewolf.cs:5585`; `Hunter` at `5624`) calls `HunterFinalShot(p, killMethod.Value, delay: true)` when `hunterFinalShot` is true | `delay=true` sets `FinalShotDelay` only | Deferred until after nightly death notifications (`Werewolf.cs:4420`), then `HunterFinalShot` executes | The selected target is killed after selection; final-shot kills invoke normal `KillPlayer` | `CheckForGameEnd()` is called after the `hunterFinalShot` dictionary is processed (`Werewolf.cs:4441`) |
| Daytime voting death of a Hunter | `KillPlayer(..., isNight: false)` (`Werewolf.cs:2766`) calls `HunterFinalShot(p, KillMthd.Lynch)` when `hunterFinalShot` is true | Immediate 30-second interaction | Blocking in the reference | Target kill resolves before control returns | `CheckForGameEnd(true)` follows in the lynch path (`Werewolf.cs:2795`) |
| Hunter killed by serial killer | `KillPlayer(..., hunterFinalShot: false)` (`Werewolf.cs:4893`) | Suppressed; no final shot | Synchronous death only | No chained target kill | Normal win evaluation follows after the serial killer segment |
| Hunter killed by fall into grave / idle / flee / normal burn / most special-case kills | Explicit `hunterFinalShot: false` call sites | Suppressed | Synchronous death only | No final shot | Normal win evaluation |
| Hunter lover dies | `KillLover` (`hunterFinalShot` branch at `Werewolf.cs:5612`) and delayed final-shot queue at `4207` | Can be extended with `FinalShotDelay` | Deferred in the reference | Lover-result handling proceeds per standard engine | Follows night completion |
| Hunter dies from repeated wolf target | The kill-path loaded tree uses `hunterFinalShot: false` for the second wolf kill | Suppressed | Synchronous death only | No final shot | Normal win evaluation |
| No choice / skip / expired 30 seconds | `HunterFinalShot` returns without a valid target | No target kill | Occupies the entire 30 second slot | None | Normal win checks continue after return |
| Valid final-shot target | `HunterFinalShot` calls `KillPlayer(killed, KillMthd.HunterShot, killer: hunter, isNight: false)` (`Werewolf.cs:5483`) | The final shot consumes the slot | Target dies as Hunter kills it; chained `KillPlayer` effects execute recursively | Chained effects complete before routine returns | Win evaluation follows the chain, not before it |

Unresolved source details:
- The exact reference `FinalShotDelay` and `FinalShotDelay?` logic not fully extracted beyond the call sites documented above.
- The exact reason some `hunterFinalShot` call sites disable it is implicit in call context; a line-by-line matrix is still needed before a faithful implementation.
- The reference has no project-style durable deadline.

### Hunter trigger dispositions (Stage E8)

- Ordinary validated death: `VERIFIED`. `KillPlayer` checks `hunterFinalShot` and calls `HunterFinalShot` synchronously or defers it via `FinalShotDelay` when `isNight` is true (`Werewolf.cs:5624`).
- `FallGrave`: `VERIFIED suppressed`. `killer: visited` and `diedByVisitingKiller` uses `hunterFinalShot: false` (`Werewolf.cs:2393`).
- `Idle`: `VERIFIED suppressed`. `KillMthd.Idle` calls `HunterFinalShot: false`, and `KillPlayer` also returns before role-specific effects for idle/flee (`Werewolf.cs:2682`, `5603`).
- `Burn`: `VERIFIED suppressed`. Arsonist burn calls use `hunterFinalShot: false` (`Werewolf.cs:3199`).
- Repeated wolf eat: `VERIFIED suppressed`. The second/multiple target kill passes `hunterFinalShot: false` (`Werewolf.cs:3367`, `3428`).
- `Flee`: `VERIFIED suppressed`. `KillPlayer(..., hunterFinalShot: false)` (`Werewolf.cs:5376`).
- Sk/SK-vs-Hunter endgame: `VERIFIED suppressed`. The Hunter killed by the serial killer uses `hunterFinalShot: false` (`Werewolf.cs:4893`).
- Gunner/SK/random death? Not separately traced beyond generic `KillPlayer`; if a source call site omits `hunterFinalShot` it defaults to true. Exact exhaustive tree still requires per-call review.
- Wolf-cub special promotion: not a Hunter trigger issue in itself.
- Lover death: `PARTIALLY UNRESOLVED`. `lover.FinalShotDelay` and `HunterFinalShot(hoter/lover)` are visible, but repeated lover-deaths and multiple hunters need separate full tracing.
- `FinalShotDelay` lifecycle: verified as a nullable kill method replayed later in the night cycle (`Werewolf.cs:4420`-`4424`, plus `hunterFinalShot.Add(p, p.FinalShotDelay.Value)`), then synchronous menu execution. Exact scheduler/maximum delay and overlap behavior are inferred only from those lines and remain marked UNRESOLVED.
- Dispositions NOT APPLICABLE for non-Hunter roles but still relevant: Arsonist burn delays and Serial Killer end-of-game (`Werewolf.cs:4866`) also suppress final shots.


### Hunter edge-case source traces (Stage E9)

#### FinalShotDelay overlap
- `HunterFinalShot(..., delay: true)` sets `hunter.FinalShotDelay = method` and returns (`Werewolf.cs:5424-5426`). It does not append to a collection; assigning the same nullable property again overwrites any previously recorded pending shot.
- Delay replays are assembled once per night inside the night death notification block. Burn-death lovers are added with `hunterFinalShot.Add(lover, KillMthd.LoverDied)`; matching Hunters are added from `burnDeaths.Where(x => x.FinalShotDelay.HasValue)`; ordinary night deaths and their lovers get the same treatment (`Werewolf.cs:4209-4210`, `4420-4421`).
- A final-shot dictionary maps `IPlayer` to `KillMthd` and only dictionary `.Add` protects duplicate keys (`Werewolf.cs:4420-4425`). The code does not clear `FinalShotDelay`, so if assignment plus replay races, duplicate dictionary addition can throw (`ArgumentException`), rather than cancelling safely.
- The loop executes each stored `HunterFinalShot` synchronously before `CheckForGameEnd()` (`Werewolf.cs:4424-4441`). A deferred shot can run a recursive final-shot kill during the same synchronous blocked loop.
- If the Hunter dies before the delay replay or another valid path removes the player, `IsDead` is still false only for the 30-second menu; the replay `Players.Where(x => !x.IsDead)` runs before entering the callback (`Werewolf.cs:5433`) and therefore does not validate anything after the callback is already running.
- `VERIFIED`: delays replace rather than queue; exact overlap behavior is overwrite plus the dictionary guard.
- `PARTIALLY UNRESOLVED`: the missing evidence is the exception-handling wrapper and whether the main call catches the duplicate-dictionary throw.

#### Lover deaths
- `KillPlayer` marks the victim dead, then if `p.InLove` and the lover is still alive visits `KillLover` (`Werewolf.cs:5613-5618`). One lover-death recursion is performed with `KillMthd.LoverDied`.
- `KillLover` sends the lover-death message, then calls `KillPlayer(lovers, KillMthd.LoverDied, killer: victim, isNight: sendNoMessage)` (`Werewolf.cs:5713`). During that second call the lover has `InLove`, but the original victim is now already dead, so the guard prevents infinite recursion.
- If the lover is a Hunter, `KillPlayer` case `IRole.Hunter` runs with `hunterFinalShot` default true, so `HunterFinalShot(lovelier, KillMthd.LoverDied, delay: isNight)` executes (`Werewolf.cs:5623`).
- When a Hunter is the initial victim and the couple is broken by the partner dying, the Hunter case runs with the original `hunterFinalShot` flag, which may be delayed or suppressed as in the initiating call.
- Night sequencing adds `p.FinalShotDelay` and, when lover final shot was set, `lover.FinalShotDelay` before processing (`Werewolf.cs:4420-4421`).
- `VERIFIED`: exactly one recursive lover death; `KillMthd.LoverDied` propagation; delayed final shot only when `delay=true`.
- `PARTIALLY UNRESOLVED`: explicit exception handling around recursive lover chains and simultaneous `dyingSimultaneously` interactions with thelover branch.

#### Remaining suppression branches
- Burn path uses `hunterFinalShot: false` in the relevant Wolf/Hunter interactions (`Werewolf.cs:3199`, `3367`, `3428`). In the wolf plurality/eat branches, suppression makes the wolf-eat kill itself not trigger the Hunter, but subsequent `KillPlayer(shotWuff, ...)` can then process the separate shot as a normal Hunter trigger (`Werewolf.cs:3372`).
- Idle and flee suppression (`hunterFinalShot: false`) return before lover-death chaining unless the ordinary `KillPlayer` has already processed it: `WolfCubCase` etc. cause ordinary role swap (`Werewolf.cs:2685`, etc.).
- Serial killer murder with `hunterFinalShot: false` at `4893` leaves the Hunter already dead with no final shot menu; that is intentional to avoid a terminal-state self-shot. Later SK endgame at `~4860` also `hunterFinalShot: false`.
- Delayed final shots are not suppressed by the initial kill, because `hunterFinalShot` remains true up to the point where `KillPlayer` is reached. Once queued, menues run even if another death chain also adds the Hunter to the dictionary.
- `VERIFIED` for burn, idle, flee, SK, and watcher.
- `PARTIALLY UNRESOLVED`: interaction of a Hunter dying from burn versus the same Hunter being lover of another Burn victim, because `burnDeaths.Where(x => x.FinalShotDelay.HasValue)` adds both contributors but dictionary guard could throw.

### Hunter shared-path and simultaneous-death traces (Stage E10)

#### Exception handling
- `VERIFIED (no explicit handling)`: the deferred-night `hunterFinalShot` loop is inside the normal nightly resolution block at `Werewolf.cs:4424-4425` with no surrounding `try`/`catch` for hunter-specific dictionary duplication or Menu callback failure.
- If `hunterFinalShot.Add(...)` encounters duplicate source-queued state, it would throw `ArgumentException` directly and abort the remainder of the night notification/resolution path; the same loop also blocks `CheckForGameEnd()` from being reached until all queued callbacks finish (`Werewolf.cs:4424-4441`).
- Dict entries are keyed on `IPlayer`; a delayed and immediate death of the same Hunter in one cycle can only add the same key once. The source does not deduplicate before `Add`, nor normalize state after dispatch.
- `FINALITY`: reference exception safety is effectively unsupported from source; this project should adapt by deduplicating by `(RoomId, HunterPlayerId)` before dispatch and using transactional claim semantics.
- Deterministic test: queue the same Hunter twice for final shot and verify one dispatch wins without a duplicate dictionary exception.

#### Simultaneous death combinations
- `Hunter + Hunter in one resolution cycle`: the loop runs synchronously and sequentially. The first menu waits 30 seconds and optionally executes a `HunterShot` kill, which itself calls `KillPlayer(...)` with recursive effect before the second menu (`Werewolf.cs:4424-4425`, `5482-5488`, `5623`).
- `Hunter + lover death`: `KillLover` invokes the lover's role switch including Hunter Menus; the lover case can execute while the initial death notification list is still being assembled, but a strict “first die, then lover dies” ordering is source guaranteed only at `KillPlayer` lines 5614-5618.
- `Overlapping delayed shot slots`: `FinalShotDelay` represents at most one delayed method. It overwrites on reassignment and is then replayed once after the night death list is complete.
- `Second Hunter dies while first is still selecting`: since the menu is synchronous, no second menu can begin until the first manager returns; therefore the reference serializes Menus globally rather than permitting overlapping elections.
- `Suppress + another trigger on same player`: suppression flags prevent normal `Hunter` logic for burned/flee/idle/sk victims, while a separate shot path can produce a new `HunterShot` trigger. The exact order is source-given if both method calls already use distinct flags.
- `VERIFIED` order: state mutation first, chatter, Delay add, deferred menu dispatch, recursive kills next, then `CheckForGameEnd` (`Werewolf.cs:4441`). `PARTIALLY UNRESOLVED`: runtime ordering cannot be proven independent of Telegram callback/threading beyond source lack of async locks.
- `SAFE POLICY`: implement strict sequential durable actions where a concurrent retrigger can create at most one prompt. The prompt lives on the triggering player row with a deadline; the first submission wins and later ones are idempotent/rejected, and expiry clears only the originating prompt.

### Implementation readiness decision (Stage E10)
- **READY WITH EXPLICIT ADAPTATION**: every critical Hunter branch now has either exact source evidence or a documented bounded adaptation.
- The adaptation required is a durable per-player prompt with a deadline, resolved by the room tick, rather than the reference's inline 30-second synchronous Telegram menu.
- Residual risk is exception handling around non-dictionary failures (Network/DB); this project must handle retries at the application layer.
## Missing source details

Exact reference mechanics for each unimplemented role are not yet documented source-by-source. The next implementation group should define one role at a time and add audited rules before enabling it in the registry. Ambiguities should be recorded here, with explicit chosen policies and tests, before database or engine changes.


## Compatibility

- `doctor` is accepted only as a legacy alias for `guardian_angel`; the active catalog exposes `guardian_angel`.
- Persisted `doctor` configurations are normalised during role validation and do not silently leave legacy role keys in active game startup.
