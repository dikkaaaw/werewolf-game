import { describe, expect, it } from 'vitest';
import { getDefaultRoleConfig } from '@/lib/game/default-roles';
import { resolveNight } from '@/lib/game/night-resolution';
import { resolveVote } from '@/lib/game/vote-resolution';
import { evaluateWinCondition } from '@/lib/game/win-condition';
import type { PlayerState, NightAction } from '@/lib/game/types';

describe('End-to-End Gameplay Loop (Lobby -> Night -> Day -> Vote -> Game Over)', () => {
  it('simulates a complete 5-player game until a win condition is reached per PRD rules', () => {
    // 1. Initial 5 players in Lobby (the approved minimum)
    const players: PlayerState[] = [
      { playerId: 'p1', userId: 'u1', seatNumber: 1, displayName: 'Alice (Host)', isAlive: true, roleKey: '', alignment: 'village' },
      { playerId: 'p2', userId: 'u2', seatNumber: 2, displayName: 'Bob', isAlive: true, roleKey: '', alignment: 'village' },
      { playerId: 'p3', userId: 'u3', seatNumber: 3, displayName: 'Charlie', isAlive: true, roleKey: '', alignment: 'village' },
      { playerId: 'p4', userId: 'u4', seatNumber: 4, displayName: 'Diana', isAlive: true, roleKey: '', alignment: 'village' },
      { playerId: 'p5', userId: 'u5', seatNumber: 5, displayName: 'Eve', isAlive: true, roleKey: '', alignment: 'village' },
    ];

    // 2. Start Game: Default 5-player role configuration
    const config = getDefaultRoleConfig(5);
    expect(config).toEqual([
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 2, config: {} },
    ]);

    // Deterministic assignment for test reproduction
    // p1 = werewolf, p2 = seer, p3 = doctor, p4/p5 = villagers
    players[0].roleKey = 'werewolf';
    players[0].alignment = 'werewolf';

    players[1].roleKey = 'seer';
    players[1].alignment = 'village';

    players[2].roleKey = 'guardian_angel';
    players[2].alignment = 'village';

    players[3].roleKey = 'villager';
    players[3].alignment = 'village';

    players[4].roleKey = 'villager';
    players[4].alignment = 'village';

    // 3. Night 1: Actions submitted
    // - Werewolf (p1) eliminates Villager (p4)
    // - Doctor (p3) protects Seer (p2)
    // - Seer (p2) investigates Werewolf (p1)
    const night1Actions: NightAction[] = [
      { actorPlayerId: 'p1', actorRoleKey: 'werewolf', actionType: 'eliminate', targetPlayerId: 'p4' },
      { actorPlayerId: 'p3', actorRoleKey: 'guardian_angel', actionType: 'protect', targetPlayerId: 'p2' },
      { actorPlayerId: 'p2', actorRoleKey: 'seer', actionType: 'investigate', targetPlayerId: 'p1' },
    ];

    const night1Result = resolveNight({
      players,
      actions: night1Actions,
    });

    // Seer learns that p1 is werewolf privately
    expect(night1Result.private.investigations).toHaveLength(1);
    expect(night1Result.private.investigations[0].targetAlignment).toBe('werewolf');

    // Villager p4 was unprotected and thus eliminated
    expect(night1Result.public.eliminated).toHaveLength(1);
    expect(night1Result.public.eliminated[0].playerId).toBe('p4');

    // Apply elimination
    players[3].isAlive = false;

    // Check Win condition post-Night 1: 1 Wolf vs 3 Villagers (Game continues)
    const postNight1Win = evaluateWinCondition(players);
    expect(postNight1Win.hasWinner).toBe(false);

    // 4. Day 1 -> Voting Phase:
    // Surviving: p1 (Wolf), p2 (Seer), p3 (Doctor). p4 is dead.
    // Seer (p2) and Doctor (p3) vote for Werewolf (p1) based on Seer's private intel.
    // Werewolf (p1) votes for Seer (p2).
    const voting1Result = resolveVote({
      players: players.filter((p) => p.isAlive),
      votes: [
        { voterPlayerId: 'p2', targetPlayerId: 'p1' },
        { voterPlayerId: 'p3', targetPlayerId: 'p1' },
        { voterPlayerId: 'p1', targetPlayerId: 'p2' },
      ],
      tieRule: 'none',
    });

    expect(voting1Result.eliminated?.playerId).toBe('p1');
    const p1Tally = voting1Result.tally.find((t) => t.targetPlayerId === 'p1');
    const p2Tally = voting1Result.tally.find((t) => t.targetPlayerId === 'p2');
    expect(p1Tally?.count).toBe(2);
    expect(p2Tally?.count).toBe(1);

    // Apply vote elimination
    players[0].isAlive = false; // Werewolf dies

    // 5. Check Win condition post-Voting 1: 0 Werewolves remain -> Village Wins!
    const finalWin = evaluateWinCondition(players);
    expect(finalWin.hasWinner).toBe(true);
    expect(finalWin.winningAlignment).toBe('village');
    expect(finalWin.aliveWerewolves).toBe(0);
    expect(finalWin.aliveNonWerewolves).toBe(3);
  });

  it('verifies doctor protection saves werewolf target during night resolution', () => {
    const players: PlayerState[] = [
      { playerId: 'w1', userId: 'u1', seatNumber: 1, displayName: 'Wolf', isAlive: true, roleKey: 'werewolf', alignment: 'werewolf' },
      { playerId: 'v1', userId: 'u2', seatNumber: 2, displayName: 'Villager', isAlive: true, roleKey: 'villager', alignment: 'village' },
      { playerId: 'd1', userId: 'u3', seatNumber: 3, displayName: 'Doc', isAlive: true, roleKey: 'guardian_angel', alignment: 'village' },
      { playerId: 's1', userId: 'u4', seatNumber: 4, displayName: 'Seer', isAlive: true, roleKey: 'seer', alignment: 'village' },
    ];

    // Wolf targets Villager v1, Doctor protects v1
    const nightActions: NightAction[] = [
      { actorPlayerId: 'w1', actorRoleKey: 'werewolf', actionType: 'eliminate', targetPlayerId: 'v1' },
      { actorPlayerId: 'd1', actorRoleKey: 'guardian_angel', actionType: 'protect', targetPlayerId: 'v1' },
    ];

    const result = resolveNight({ players, actions: nightActions });

    // Target was saved; zero eliminations
    expect(result.public.eliminated).toHaveLength(0);
    expect(result.internal.savedPlayerIds).toContain('v1');
  });

  it('verifies werewolf win condition on parity', () => {
    const players: PlayerState[] = [
      { playerId: 'w1', userId: 'u1', seatNumber: 1, displayName: 'Wolf', isAlive: true, roleKey: 'werewolf', alignment: 'werewolf' },
      { playerId: 'v1', userId: 'u2', seatNumber: 2, displayName: 'Villager', isAlive: true, roleKey: 'villager', alignment: 'village' },
      { playerId: 'v2', userId: 'u3', seatNumber: 3, displayName: 'Dead 1', isAlive: false, roleKey: 'villager', alignment: 'village' },
      { playerId: 'v3', userId: 'u4', seatNumber: 4, displayName: 'Dead 2', isAlive: false, roleKey: 'villager', alignment: 'village' },
    ];

    // 1 Wolf vs 1 Villager = parity (aliveWerewolves >= aliveNonWerewolves)
    const winResult = evaluateWinCondition(players);
    expect(winResult.hasWinner).toBe(true);
    expect(winResult.winningAlignment).toBe('werewolf');
  });
});
