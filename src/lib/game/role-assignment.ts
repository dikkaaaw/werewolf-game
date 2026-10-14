/**
 * Role assignment: shuffle players, then deal the configured role counts.
 *
 * Pure and deterministic given an injected RNG, so it is fully unit-testable
 * and replayable. Randomness comes from the platform CSPRNG — never
 * `Math.random`, which is predictable and must not decide game outcomes.
 */
import { requireRole } from './role-registry';
import type { Alignment, RoleConfigEntry } from './types';

export type Rng = () => number;

export interface RoleAssignment {
  playerId: string;
  seatNumber: number;
  roleKey: string;
  alignment: Alignment;
}

export interface AssignmentResult {
  assignments: RoleAssignment[];
  /** The role multiset that was actually dealt, for audit/logging. */
  dealt: Record<string, number>;
}

/**
 * Unbiased Fisher–Yates using rejection sampling.
 *
 * `crypto.getRandomValues` gives a uniform 32-bit integer; naively taking
 * `% n` would bias the low indices. We reject the tail of the range that does
 * not divide evenly by n.
 */
export function secureShuffle<T>(items: readonly T[], rng: Rng = secureRng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomBelow(i + 1, rng);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function randomBelow(bound: number, rng: Rng): number {
  if (bound <= 0 || !Number.isInteger(bound)) {
    throw new RangeError(`randomBelow requires a positive integer bound, got ${bound}`);
  }
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  let value = Math.floor(rng() * 0x1_0000_0000);
  while (value >= limit) {
    value = Math.floor(rng() * 0x1_0000_0000);
  }
  return value % bound;
}

/** Default RNG backed by the Web Crypto CSPRNG (available in Node 18+ and browsers). */
export const secureRng: Rng = () => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 0x1_0000_0000;
};

export interface AssignablePlayer {
  playerId: string;
  seatNumber: number;
}

/**
 * Deal `roleConfig` to `players`.
 *
 * Throws if the total role count does not equal the player count. The caller is
 * expected to have already run `validateRoleConfig`, but this assertion stays so
 * the engine cannot be misused into producing a half-dealt game.
 */
export function assignRoles(
  players: readonly AssignablePlayer[],
  roleConfig: readonly RoleConfigEntry[],
  rng: Rng = secureRng,
): AssignmentResult {
  const playerCount = players.length;
  const deck: string[] = [];

  for (const entry of roleConfig) {
    const role = requireRole(entry.roleKey); // throws on unregistered role
    if (!Number.isInteger(entry.roleCount) || entry.roleCount < 0) {
      throw new RangeError(`roleCount for ${entry.roleKey} must be a non-negative integer`);
    }
    for (let i = 0; i < entry.roleCount; i += 1) {
      deck.push(role.roleKey);
    }
  }

  if (deck.length !== playerCount) {
    throw new RangeError(
      `Role configuration deals ${deck.length} roles to ${playerCount} players; ` +
        'they must be equal',
    );
  }

  const shuffledDeck = secureShuffle(deck, rng);
  const shuffledPlayers = secureShuffle(players, rng);

  const assignments: RoleAssignment[] = shuffledPlayers.map((player, index) => {
    const roleKey = shuffledDeck[index];
    return {
      playerId: player.playerId,
      seatNumber: player.seatNumber,
      roleKey,
      alignment: requireRole(roleKey).alignment,
    };
  });

  const dealt: Record<string, number> = {};
  for (const assignment of assignments) {
    dealt[assignment.roleKey] = (dealt[assignment.roleKey] ?? 0) + 1;
  }

  return { assignments, dealt };
}
