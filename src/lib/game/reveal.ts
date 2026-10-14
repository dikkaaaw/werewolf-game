/**
 * Role-reveal policy — the single source of truth for who may see whose role.
 *
 * Pure and dependency-free by design. The security-critical property of this
 * feature is one invariant:
 *
 *     While a game is IN PROGRESS, a LIVING player's role is never public —
 *     under any setting value.
 *
 * Keeping that decision in an isolated, exhaustively unit-tested module (rather
 * than inline in a route, an SQL expression, or the UI) means the invariant is
 * proved once and reused by every surface. A route bug cannot weaken it without
 * first failing this module's tests.
 *
 * Derived from authoritative state rather than a stored `role_revealed_at`
 * column (see docs/ROLE-REVEAL-DESIGN.md, Option B): no schema change, no
 * back-fill, and a settings change takes effect immediately for every client
 * instead of drifting against a stored flag.
 *
 * Nothing else about a player is revealed here — never `alignment`, never
 * `private_state`, never Seer results. Those stay behind `/my-role`.
 */

import { SETTINGS } from './settings';

export interface RoleRevealInput {
  /** `rooms.status`. Only 'finished' unlocks the whole board. */
  roomStatus: string;
  /** `rooms.settings->>'revealRoleOnElimination'`, when present. */
  revealRoleOnElimination?: unknown;
  /** Whether the player is still in the game. */
  isAlive: boolean;
}

/**
 * Read the reveal setting defensively.
 *
 * Anything other than the exact boolean/string `false` means "reveal on
 * elimination": the setting is absent (nothing in the MVP can write it yet), or
 * it holds an unrecognised value we must not treat as a privacy-tightening
 * choice. Failing closed here would silently hide roles the rules say should be
 * public; the live invariant (never reveal the living) does not depend on this
 * branch at all.
 */
function revealOnElimination(raw: unknown): boolean {
  if (raw === false) return false;
  if (typeof raw === 'string') return raw !== 'false';
  return SETTINGS.gameplay.defaultRevealRoleOnElimination;
}

/**
 * May this player's role be shown publicly?
 *
 * | game state          | player alive | result                              |
 * | ------------------- | ------------ | ----------------------------------- |
 * | in progress         | yes          | **never** (no setting changes this) |
 * | in progress         | no           | only if `revealRoleOnElimination`   |
 * | finished            | either       | yes, unconditionally               |
 */
export function isRoleRevealed(input: RoleRevealInput): boolean {
  // Terminal disclosure: GAME-RULES §10 — "All roles are then revealed
  // publicly." Unconditional, and checked FIRST so it holds even if the caller
  // passes a nonsense status alongside it.
  if (input.roomStatus === 'finished') return true;

  // The invariant. Before anything else, and for every remaining status.
  if (input.isAlive) return false;

  return revealOnElimination(input.revealRoleOnElimination);
}