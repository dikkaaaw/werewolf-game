/**
 * Win conditions.
 *
 * Split out from the API handlers on purpose: this is the most rule-dense,
 * most test-critical module in the project and must be verifiable without a
 * database, a server, or a running game.
 *
 * Logic is expressed over *alignment*, not over roles, so adding a role can
 * never silently change who wins. See GAME-RULES.md §10.
 */
import type { PlayerState, WinResult } from './types';

export function evaluateWinCondition(players: readonly PlayerState[]): WinResult {
  const alive = players.filter((player) => player.isAlive);

  const aliveWerewolves = alive.filter((player) => player.alignment === 'werewolf').length;
  const aliveNonWerewolves = alive.length - aliveWerewolves;

  const eliminatedAlignments = [...new Set(players.map((player) => player.alignment))].filter(
    (alignment) => !alive.some((player) => player.alignment === alignment),
  );

  // Village wins by removing every werewolf.
  if (aliveWerewolves === 0) {
    return {
      hasWinner: true,
      winningAlignment: 'village',
      aliveWerewolves,
      aliveNonWerewolves,
      eliminatedAlignments,
    };
  }

  // Werewolves win on parity, provided at least one is left.
  if (aliveWerewolves >= aliveNonWerewolves) {
    return {
      hasWinner: true,
      winningAlignment: 'werewolf',
      aliveWerewolves,
      aliveNonWerewolves,
      eliminatedAlignments,
    };
  }

  return {
    hasWinner: false,
    winningAlignment: null,
    aliveWerewolves,
    aliveNonWerewolves,
    eliminatedAlignments,
  };
}

/**
 * Should the game keep running?
 *
 * Used by the phase manager to decide between `next phase` and `finished`.
 * Also guards `no players alive` — a state unreachable in the MVP, but handled
 * so a data-integrity bug cannot spin the game forever.
 */
export function shouldGameContinue(players: readonly PlayerState[]): boolean {
  if (players.every((player) => !player.isAlive)) return false;
  return !evaluateWinCondition(players).hasWinner;
}
