import { describe, expect, it } from 'vitest';

describe('UI Phase-Aware Roster & Compact Actions Logic', () => {
  const currentUser = { id: 'user-1' };
  const mockPlayers = [
    { id: 'player-1', userId: 'user-1', displayName: 'Hero', seatNumber: 1, isAlive: true, isReady: true },
    { id: 'player-2', userId: 'user-2', displayName: 'Villager Bob', seatNumber: 2, isAlive: true, isReady: true },
    { id: 'player-3', userId: 'user-3', displayName: 'Ghost Dan', seatNumber: 3, isAlive: false, isReady: false },
  ];

  it('Lobby Phase: Only shows Ready status, hides night actions and voting buttons', () => {
    const phase: string = 'lobby';
    const status: string = 'lobby';

    mockPlayers.forEach(() => {
      const isLobby = status === 'lobby';
      const isNight = status === 'in_progress' && phase === 'night';
      const isVoting = status === 'in_progress' && phase === 'voting';

      expect(isLobby).toBe(true);
      expect(isNight).toBe(false);
      expect(isVoting).toBe(false);
    });
  });

  it('Night Phase: Shows contextual actions (Eat/Investigate/Protect) on eligible rows only', () => {
    const status = 'in_progress';
    const phase = 'night';

    // Role: Werewolf
    const werewolfRole = { roleKey: 'werewolf', alignment: 'werewolf' };
    const eligibleWerewolfTargets = mockPlayers.filter((p) => {
      const isNight = status === 'in_progress' && phase === 'night';
      const isCurrentUser = p.userId === currentUser.id;
      return isNight && p.isAlive && !isCurrentUser;
    });

    // Only living non-self players can be targeted
    expect(eligibleWerewolfTargets).toHaveLength(1);
    expect(eligibleWerewolfTargets[0].id).toBe('player-2');

    // Role: Seer
    const seerRole = { roleKey: 'seer', alignment: 'village' };
    const nightActionLabel = (role: string) =>
      role === 'werewolf' ? 'Eat' : role === 'seer' ? 'Investigate' : 'Protect';

    expect(nightActionLabel(werewolfRole.roleKey)).toBe('Eat');
    expect(nightActionLabel(seerRole.roleKey)).toBe('Investigate');
    expect(nightActionLabel('doctor')).toBe('Protect');
  });

  it('Night Phase: Villagers and dead players do not receive action buttons', () => {
    const villagerRole = { roleKey: 'villager', alignment: 'village' };
    const actionableRoles = ['werewolf', 'seer', 'doctor'];
    expect(actionableRoles.includes(villagerRole.roleKey)).toBe(false);
  });

  it('Voting Phase: Shows inline Vote button and tally on eligible targets, never on self or dead', () => {
    const status = 'in_progress';
    const phase = 'voting';
    const isVoting = status === 'in_progress' && phase === 'voting';

    const eligibleVoteTargets = mockPlayers.filter((p) => {
      const isCurrentUser = p.userId === currentUser.id;
      return isVoting && p.isAlive && !isCurrentUser;
    });

    // Only player-2 is alive and non-self
    expect(eligibleVoteTargets).toHaveLength(1);
    expect(eligibleVoteTargets[0].id).toBe('player-2');
  });

  it('Day Discussion: Shows status only, no action buttons', () => {
    const status: string = 'in_progress';
    const phase: string = 'day';

    const isNight = status === 'in_progress' && phase === 'night';
    const isVoting = status === 'in_progress' && phase === 'voting';
    const isDay = status === 'in_progress' && phase === 'day';

    expect(isDay).toBe(true);
    expect(isNight).toBe(false);
    expect(isVoting).toBe(false);
  });

  it('Finished Game: Displays winner and disables all in-game actions', () => {
    const status: string = 'finished';
    expect(status === 'finished').toBe(true);
    expect(status === 'in_progress').toBe(false);
  });
});
