# Werewolf Simplification & Architecture Plan

Based on reverse-engineering the upstream reference (`GreyWolfDev/Werewolf`).

## Core Concept from Reference

Upstream Werewolf for Telegram runs games sequentially:
- A game is driven by linear phase cycles: `NightCycle() -> DayCycle() -> LynchCycle() -> CheckForGameEnd()`.
- Players hold ephemeral state: `Role, IsDead, Choice, Choice2, Votes, CurrentQuestion`.
- When an interactive action occurs (e.g. Hunter death), a prompt (`CurrentQuestion`) is placed on the player with a 30-second window. If not answered, it times out with no kill.

## Web Translation Architecture

1. **Authoritative Room State Machine:**
   - Single atomic PostgreSQL RPC `tick_room(p_room_id uuid)` locks the room row via `SELECT ... FOR UPDATE`.
   - Replaces multi-step client roundtrips (`claim_phase_transition` -> client TS logic -> `commit_phase_transition` -> `release_phase_transition_claim`).
   - Automatically resolves night protections/kills/seer investigations, day announcements, voting tallies, prompt timeouts, and win conditions in a single database transaction.

2. **Per-Player Prompts:**
   - Stored directly on `room_players.prompt` (`jsonb`) and `room_players.prompt_deadline_at` (`timestamptz`).
   - Replaces generic `game_pending_actions` and `death_resolution_cycles` / `death_resolution_work_items`.
   - Survives browser reloads, disconnections, and server restarts.

3. **Thin Application Layer:**
   - `advanceRoomPhaseIfExpired(roomId)` in `src/lib/server/phase-advancement.ts` simply calls `admin.rpc('tick_room', { p_room_id: roomId })`.
   - Next.js route handlers validate sessions and rates, then delegate authoritatively to Postgres.

## Execution Progress

- [x] **Phase 0 — Remove Dead Infrastructure:**
  - Removed unused generic pending actions routes (`api/internal/pending-actions/*`) and tests.
  - Added forward migration `0025_drop_generic_pending_actions.sql`.
- [x] **Phase 1 — Hunter Prompt Simplification:**
  - Added `room_players.prompt` and `prompt_deadline_at`.
  - Added forward migration `0026_hunter_prompt_model.sql` dropping `death_resolution_cycles` and `work_items`.
  - Simplified `my-role/route.ts` to read prompt directly from caller's player row.
- [x] **Phase 2 — Single Atomic `tick_room`:**
  - Added forward migration `0027_tick_room.sql` implementing atomic phase resolution under `FOR UPDATE` lock.
  - Reduced `phase-advancement.ts` from 473 lines down to a clean, robust wrapper.
  - Verified 100% test pass rate across all 44 test files (561 tests) including full HTTP E2E.
- [ ] **Phase 3 (Future / Optional):**
  - Deprecate old `claim_phase_transition` / `commit_phase_transition` helper RPCs when external tests are fully phased out.
  - Add next batch of upstream roles (Gunner, Detective, Mayor) following the same prompt + tick pattern.
