import { describe, expect, it } from 'vitest';

import { resolveVote } from '@/lib/game/vote-resolution';
import { evaluateWinCondition, shouldGameContinue } from '@/lib/game/win-condition';
import type { Alignment, PlayerState, VoteRecord } from '@/lib/game/types';

function player(
  id: string,
  seat: number,
  alignment: Alignment,
  isAlive = true,
): PlayerState {
  return {
    playerId: id,
    userId: `u-${id}`,
    seatNumber: seat,
    displayName: `Player ${seat}`,
    isAlive,
    alignment,
    roleKey: alignment === 'werewolf' ? 'werewolf' : 'villager',
  };
}

/** 9 players: 3 werewolves, 6 village. */
const ninePlayers: PlayerState[] = [
  player('p1', 1, 'werewolf'),
  player('p2', 2, 'werewolf'),
  player('p3', 3, 'werewolf'),
  player('p4', 4, 'village'),
  player('p5', 5, 'village'),
  player('p6', 6, 'village'),
  player('p7', 7, 'village'),
  player('p8', 8, 'village'),
  player('p9', 9, 'village'),
];

const vote = (voterPlayerId: string, targetPlayerId: string): VoteRecord => ({
  voterPlayerId,
  targetPlayerId,
});

const withAlive = (base: PlayerState[], deadIds: string[]) =>
  base.map((p) => (deadIds.includes(p.playerId) ? { ...p, isAlive: false } : p));

describe('resolveVote', () => {
  it('eliminates the plurality target', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p4'), vote('p3', 'p5'), vote('p6', 'p6')];
    const result = resolveVote({ players: ninePlayers, votes, tieRule: 'none' });

    expect(result.eliminated).toMatchObject({ playerId: 'p4', cause: 'vote_elimination' });
    expect(result.reason).toBe('elected');
    expect(result.tieBroken).toBe(false);
  });

  it('eliminates nobody when there are no votes', () => {
    const result = resolveVote({ players: ninePlayers, votes: [], tieRule: 'none' });

    expect(result.eliminated).toBeNull();
    expect(result.reason).toBe('no_votes');
  });

  it('a tie eliminates nobody by default', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p5')];
    const result = resolveVote({ players: ninePlayers, votes, tieRule: 'none' });

    expect(result.eliminated).toBeNull();
    expect(result.reason).toBe('tie_no_elimination');
    expect(result.tiedPlayerIds.sort()).toEqual(['p4', 'p5']);
  });

  it('a tie picks one of the tied players when the rule says random', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p5')];
    const result = resolveVote({ players: ninePlayers, votes, tieRule: 'random', rng: () => 0 });

    expect(result.eliminated?.playerId).toBe('p4');
    expect(result.tieBroken).toBe(true);
    expect(result.reason).toBe('tie_random');
  });

  it('the random tie-break stays within the tied set', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p5'), vote('p3', 'p7')];
    for (const rng of [0, 0.34, 0.67, 0.99]) {
      const result = resolveVote({ players: ninePlayers, votes, tieRule: 'random', rng: () => rng });
      expect(['p4', 'p5', 'p7']).toContain(result.eliminated?.playerId);
    }
  });

  it('ignores votes cast by dead players', () => {
    const dead = withAlive(ninePlayers, ['p1']);
    const votes = [vote('p1', 'p4'), vote('p2', 'p6')];
    const result = resolveVote({ players: dead, votes, tieRule: 'none' });

    // Without p1's vote, p6 has 1 and p4 has 0 -> p6 is elected.
    expect(result.eliminated?.playerId).toBe('p6');
  });

  it('ignores votes for players who are not in the roster', () => {
    const votes = [vote('p1', 'ghost'), vote('p2', 'p6')];
    const result = resolveVote({ players: ninePlayers, votes, tieRule: 'none' });

    expect(result.eliminated?.playerId).toBe('p6');
  });

  it('reports a full tally, not just the winner', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p4'), vote('p3', 'p5')];
    const result = resolveVote({ players: ninePlayers, votes, tieRule: 'none' });

    expect(result.tally).toEqual([
      { targetPlayerId: 'p4', count: 2 },
      { targetPlayerId: 'p5', count: 1 },
    ]);
  });

  it('is order-independent', () => {
    const votes = [vote('p1', 'p4'), vote('p2', 'p4'), vote('p3', 'p5'), vote('p6', 'p6')];
    const a = resolveVote({ players: ninePlayers, votes, tieRule: 'none' });
    const b = resolveVote({ players: ninePlayers, votes: [...votes].reverse(), tieRule: 'none' });

    expect(b).toEqual(a);
  });
});

describe('evaluateWinCondition', () => {
  it('no winner while both sides are alive', () => {
    const result = evaluateWinCondition(ninePlayers);

    expect(result.hasWinner).toBe(false);
    expect(result.winningAlignment).toBeNull();
    expect(result.aliveWerewolves).toBe(3);
    expect(result.aliveNonWerewolves).toBe(6);
  });

  it('the village wins when every werewolf is dead', () => {
    const result = evaluateWinCondition(withAlive(ninePlayers, ['p1', 'p2', 'p3']));

    expect(result.hasWinner).toBe(true);
    expect(result.winningAlignment).toBe('village');
  });

  it('the werewolves win on parity', () => {
    // 9 players: kill 4 villagers -> 3 wolves vs 2 villagers.
    const result = evaluateWinCondition(withAlive(ninePlayers, ['p4', 'p5', 'p6', 'p7']));

    expect(result.hasWinner).toBe(true);
    expect(result.winningAlignment).toBe('werewolf');
    expect(result.aliveWerewolves).toBe(3);
    expect(result.aliveNonWerewolves).toBe(2);
  });

  it('no winner while the werewolves are outnumbered', () => {
    const result = evaluateWinCondition(withAlive(ninePlayers, ['p4', 'p5']));

    expect(result.hasWinner).toBe(false);
    expect(result.winningAlignment).toBeNull();
    expect(result.aliveWerewolves).toBe(3);
    expect(result.aliveNonWerewolves).toBe(4);
  });

  it('a 1-1 endgame is a werewolf win', () => {
    const two: PlayerState[] = [player('w', 1, 'werewolf'), player('v', 2, 'village')];
    const result = evaluateWinCondition(two);

    expect(result.winningAlignment).toBe('werewolf');
  });

  it('a lone survivor who is a villager is a village win', () => {
    const solo: PlayerState[] = [player('v', 1, 'village')];
    const result = evaluateWinCondition(solo);

    expect(result.winningAlignment).toBe('village');
  });

  it('reports which alignments have been wiped out', () => {
    const result = evaluateWinCondition(withAlive(ninePlayers, ['p1', 'p2', 'p3']));

    expect(result.eliminatedAlignments).toContain('werewolf');
    expect(result.eliminatedAlignments).not.toContain('village');
  });

  it('handles an empty roster without crashing', () => {
    const result = evaluateWinCondition([]);

    expect(result.hasWinner).toBe(true);
    expect(result.aliveWerewolves).toBe(0);
  });
});

describe('shouldGameContinue', () => {
  it('continues mid-game', () => {
    expect(shouldGameContinue(ninePlayers)).toBe(true);
  });

  it('stops once the village wins', () => {
    expect(shouldGameContinue(withAlive(ninePlayers, ['p1', 'p2', 'p3']))).toBe(false);
  });

  it('stops if everyone is dead (integrity guard)', () => {
    expect(shouldGameContinue(withAlive(ninePlayers, ninePlayers.map((p) => p.playerId)))).toBe(false);
  });
});
