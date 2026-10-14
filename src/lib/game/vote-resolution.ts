/**
 * Open voting resolution.
 *
 * Voting is open: every living player holds exactly one active vote per round
 * and may change it until the deadline. The database enforces the uniqueness,
 * so by the time this runs there is one row per voter at most.
 *
 * See GAME-RULES.md §8.
 */
import type {
  Elimination,
  PlayerState,
  VoteRecord,
  VoteResolutionResult,
  VoteTally,
  VoteTieRule,
} from './types';

export interface VoteResolutionInput {
  players: readonly PlayerState[];
  votes: readonly VoteRecord[];
  tieRule: VoteTieRule;
  /**
   * Uniform [0,1) source, injected so the `random` tie-break is testable.
   * Ignored when `tieRule === 'none'`.
   */
  rng?: () => number;
}

export function resolveVote(input: VoteResolutionInput): VoteResolutionResult {
  const { players, votes, tieRule } = input;
  const rng = input.rng ?? Math.random;

  const byId = new Map(players.map((player) => [player.playerId, player]));

  // Only living voters count, and only if they still exist.
  const counts = new Map<string, number>();
  for (const vote of votes) {
    const voter = byId.get(vote.voterPlayerId);
    if (!voter || !voter.isAlive) continue;

    // The target must also be a living member of this roster. The database
    // rejects invalid targets at write time, but the engine must not rely on
    // that: a stale or forged row must not be able to manufacture a tie (or a
    // win) by voting for someone who does not exist.
    const target = byId.get(vote.targetPlayerId);
    if (!target || !target.isAlive) continue;

    counts.set(vote.targetPlayerId, (counts.get(vote.targetPlayerId) ?? 0) + 1);
  }

  const tally: VoteTally[] = [...counts.entries()]
    .map(([targetPlayerId, count]) => ({ targetPlayerId, count }))
    .sort((a, b) => b.count - a.count || compareBySeat(a.targetPlayerId, b.targetPlayerId, byId));

  if (tally.length === 0 || tally[0].count === 0) {
    return {
      eliminated: null,
      tally: [],
      tieBroken: false,
      tiedPlayerIds: [],
      reason: 'no_votes',
    };
  }

  const topCount = tally[0].count;
  const tiedPlayerIds = tally.filter((entry) => entry.count === topCount).map((e) => e.targetPlayerId);

  // A "tie" of one is just a winner.
  if (tiedPlayerIds.length === 1) {
    return {
      eliminated: toElimination(tiedPlayerIds[0], byId),
      tally,
      tieBroken: false,
      tiedPlayerIds,
      reason: 'elected',
    };
  }

  if (tieRule === 'none') {
    return {
      eliminated: null,
      tally,
      tieBroken: false,
      tiedPlayerIds,
      reason: 'tie_no_elimination',
    };
  }

  // `random`: uniform pick among the tied targets. Sorted first so the random
  // draw does not depend on map iteration order.
  const sortedTied = [...tiedPlayerIds].sort();
  const index = Math.min(sortedTied.length - 1, Math.floor(rng() * sortedTied.length));
  const chosen = sortedTied[index];

  return {
    eliminated: toElimination(chosen, byId),
    tally,
    tieBroken: true,
    tiedPlayerIds: sortedTied,
    reason: 'tie_random',
  };
}

function toElimination(playerId: string, byId: ReadonlyMap<string, PlayerState>): Elimination | null {
  const player = byId.get(playerId);
  if (!player) return null;
  return {
    playerId: player.playerId,
    seatNumber: player.seatNumber,
    displayName: player.displayName,
    cause: 'vote_elimination',
  };
}

function compareBySeat(
  a: string,
  b: string,
  byId: ReadonlyMap<string, PlayerState>,
): number {
  return (byId.get(a)?.seatNumber ?? 0) - (byId.get(b)?.seatNumber ?? 0);
}
