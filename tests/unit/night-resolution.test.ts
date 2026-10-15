import { describe, expect, it } from 'vitest';
import { resolveNight } from '@/lib/game/night-resolution';
import type { NightAction, PlayerState } from '@/lib/game/types';

/**
 * Night-resolution rules from docs/GAME-RULES.md §6. These exercise the real
 * `resolveNight` used by the phase-advancement night branch.
 */

function player(
  id: string,
  seatNumber: number,
  roleKey: PlayerState['roleKey'] = 'villager',
  alignment: PlayerState['alignment'] = 'village',
  isAlive = true,
): PlayerState {
  return {
    playerId: id,
    userId: `u-${id}`,
    seatNumber,
    displayName: id,
    isAlive,
    alignment,
    roleKey,
  };
}

function act(
  actorPlayerId: string,
  actorRoleKey: NightAction['actorRoleKey'],
  actionType: NightAction['actionType'],
  targetPlayerId: string,
): NightAction {
  return { actorPlayerId, actorRoleKey, actionType, targetPlayerId };
}

describe('resolveNight — elimination rules (GAME-RULES §6)', () => {
  it('eliminates the plurality target across multiple werewolves', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('w2', 2, 'werewolf', 'werewolf'),
      player('v1', 3),
      player('v2', 4),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('w2', 'werewolf', 'eliminate', 'v1'),
      ],
    });
    expect(result.public.eliminated.map((e) => e.playerId)).toEqual(['v1']);
  });

  it('breaks a plurality tie deterministically by lowest seat number', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('w2', 2, 'werewolf', 'werewolf'),
      player('v1', 3),
      player('v2', 4),
    ];
    // One vote each: the tie must resolve to v1 (seat 3) over v2 (seat 4).
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('w2', 'werewolf', 'eliminate', 'v2'),
      ],
    });
    expect(result.public.eliminated.map((e) => e.playerId)).toEqual(['v1']);
  });

  it('is order-independent: the same actions in reverse order resolve identically', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('w2', 2, 'werewolf', 'werewolf'),
      player('v1', 3),
      player('v2', 4),
    ];
    const a = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('w2', 'werewolf', 'eliminate', 'v1'),
      ],
    });
    const b = resolveNight({
      players,
      actions: [
        act('w2', 'werewolf', 'eliminate', 'v1'),
        act('w1', 'werewolf', 'eliminate', 'v1'),
      ],
    });
    expect(a.public.eliminated).toEqual(b.public.eliminated);
  });

  it('collapses duplicate kills on one player into a single death', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('w2', 2, 'werewolf', 'werewolf'),
      player('v1', 3),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('w2', 'werewolf', 'eliminate', 'v1'),
      ],
    });
    expect(result.public.eliminated).toHaveLength(1);
  });

  it('does not eliminate a player who was already dead before the night', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('v1', 2, 'villager', 'village', false),
      player('v2', 3),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('w1', 'werewolf', 'eliminate', 'v2'),
      ],
    });
    // Only the living target is eligible; the dead one is filtered out.
    expect(result.public.eliminated.map((e) => e.playerId)).toEqual(['v2']);
  });

  it('a doctor protecting a dead player does not bring them into the protect set', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('d1', 2, 'guardian_angel'),
      player('v1', 3, 'villager', 'village', false),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('d1', 'guardian_angel', 'protect', 'v1'),
      ],
    });
    expect(result.internal.protectedPlayerIds).toEqual([]);
    expect(result.public.eliminated).toEqual([]);
  });
});

describe('resolveNight — doctor protection precedence (GAME-RULES §6 step 2)', () => {
  it('a protected target survives: killIds is the difference', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('d1', 2, 'guardian_angel'),
      player('v1', 3),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('d1', 'guardian_angel', 'protect', 'v1'),
      ],
    });
    expect(result.public.eliminated).toEqual([]);
    expect(result.internal.savedPlayerIds).toContain('v1');
    // The attack still counts as an attack even though it was negated.
    expect(result.internal.attackedPlayerIds).toContain('v1');
  });

  it('protection does not spare an un-attacked player from other bookkeeping', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('d1', 2, 'guardian_angel'),
      player('v1', 3),
      player('v2', 4),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v2'),
        act('d1', 'guardian_angel', 'protect', 'v1'),
      ],
    });
    // v1 was protected but not attacked, so nothing is "saved".
    expect(result.internal.savedPlayerIds).toEqual([]);
    expect(result.public.eliminated.map((e) => e.playerId)).toEqual(['v2']);
  });
});

describe('resolveNight — seer investigation (GAME-RULES §6 step 3)', () => {
  it('reports the target alignment even when that target dies the same night', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('v1', 2),
      player('s1', 3, 'seer'),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('w1', 'werewolf', 'eliminate', 'v1'),
        act('s1', 'seer', 'investigate', 'v1'),
      ],
    });
    // The target was eliminated tonight, but the private result is still
    // produced and still reflects the pre-resolution truth.
    expect(result.public.eliminated.map((e) => e.playerId)).toEqual(['v1']);
    expect(result.private.investigations).toEqual([
      { actorPlayerId: 's1', targetPlayerId: 'v1', targetAlignment: 'village' },
    ]);
  });

  it('reveals a werewolf alignment to the seer', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('v1', 2),
      player('s1', 3, 'seer'),
    ];
    const result = resolveNight({
      players,
      actions: [act('s1', 'seer', 'investigate', 'w1')],
    });
    expect(result.private.investigations[0].targetAlignment).toBe('werewolf');
  });

  it('does not let the investigation leak into the public bucket', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('s1', 2, 'seer'),
    ];
    const result = resolveNight({
      players,
      actions: [act('s1', 'seer', 'investigate', 'w1')],
    });
    expect(result.public.eliminated).toEqual([]);
    const serialised = JSON.stringify(result.public);
    expect(serialised).not.toContain('werewolf');
    expect(serialised).not.toContain('investigate');
  });

  it('produces one investigation per investigate action', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('v1', 2),
      player('v2', 3),
      player('s1', 4, 'seer'),
    ];
    const result = resolveNight({
      players,
      actions: [
        act('s1', 'seer', 'investigate', 'w1'),
        act('s1', 'seer', 'investigate', 'v2'),
      ],
    });
    expect(result.private.investigations).toHaveLength(2);
  });
});

describe('resolveNight — idempotent replay (F3 retry)', () => {
  it('resolves identically when the same action set is resolved twice', () => {
    const players = [
      player('w1', 1, 'werewolf', 'werewolf'),
      player('d1', 2, 'guardian_angel'),
      player('v1', 3),
      player('s1', 4, 'seer'),
    ];
    const actions = [
      act('w1', 'werewolf', 'eliminate', 'v1'),
      act('d1', 'guardian_angel', 'protect', 'v1'),
      act('s1', 'seer', 'investigate', 'v1'),
    ];
    const first = resolveNight({ players, actions });
    const replay = resolveNight({ players, actions });
    // Resolution is pure, so a retry yields byte-identical output; the
    // de-duplication of the persisted rows is the database's job.
    expect(replay).toEqual(first);
    expect(first.public.eliminated).toEqual([]);
    expect(first.private.investigations).toHaveLength(1);
  });
});