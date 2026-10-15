import { describe, expect, it } from 'vitest';

import { getRole, isRegisteredRole, listRoleKeys } from '@/lib/game/role-registry';
import { resolveNight } from '@/lib/game/night-resolution';
import { validateNightAction } from '@/lib/game/action-validation';
import type { NightAction, PlayerState } from '@/lib/game/types';

describe('Lycan role contract', () => {
  it('is registered with wolf-team win participation', () => {
    expect(isRegisteredRole('lycan')).toBe(true);
    const lycan = getRole('lycan');
    expect(lycan?.alignment).toBe('werewolf');
    expect(lycan?.countsForWinAs).toBe('werewolf');
    expect(lycan?.nightAction).toBeNull();
    expect(listRoleKeys()).toContain('lycan');
  });

  it('cannot be targeted by a Werewolf', () => {
    const wolf: PlayerState = {
      playerId: 'p1', userId: 'u1', seatNumber: 1, displayName: 'Wolf',
      isAlive: true, alignment: 'werewolf', roleKey: 'werewolf',
    };
    const lycanTarget: PlayerState = {
      playerId: 'p2', userId: 'u2', seatNumber: 2, displayName: 'Lycan',
      isAlive: true, alignment: 'werewolf', roleKey: 'lycan',
    };
    const verdict = validateNightAction({
      actor: wolf, target: lycanTarget, actionType: 'eliminate',
      phase: 'night', roomStatus: 'in_progress', phaseExpired: false,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('target_is_werewolf');
  });

  it('is reported to Seer as Village alignment', () => {
    const seer: PlayerState = {
      playerId: 'p1', userId: 'u1', seatNumber: 1, displayName: 'Seer',
      isAlive: true, alignment: 'village', roleKey: 'seer',
    };
    const lycan: PlayerState = {
      playerId: 'p2', userId: 'u2', seatNumber: 2, displayName: 'Lycan',
      isAlive: true, alignment: 'werewolf', roleKey: 'lycan',
    };
    const nightAction: NightAction = {
      actorPlayerId: 'p1', actorRoleKey: 'seer', actionType: 'investigate', targetPlayerId: 'p2',
    };
    const result = resolveNight({ players: [seer, lycan], actions: [nightAction] });
    expect(result.private.investigations).toEqual([
      { actorPlayerId: 'p1', targetPlayerId: 'p2', targetAlignment: 'village' },
    ]);
  });
});
