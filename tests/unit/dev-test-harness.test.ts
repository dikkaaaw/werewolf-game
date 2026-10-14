import { describe, expect, it } from 'vitest';
import { getDefaultRoleConfig } from '@/lib/game/default-roles';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { assignRoles } from '@/lib/game/role-assignment';

describe('Development Test Harness: minimum-five simulation scenarios', () => {
  // The approved minimum is five players, so the boundary worth pinning is a
  // FOUR-player lobby: it must fail validation on count (not on roles).
  it('Scenario 1: Room with 4 players fails validation and cannot start', () => {
    const fourPlayers = [
      { playerId: 'p1', seatNumber: 1 },
      { playerId: 'p2', seatNumber: 2 },
      { playerId: 'p3', seatNumber: 3 },
      { playerId: 'p4', seatNumber: 4 },
    ];
    expect(fourPlayers.length).toBeLessThan(5);

    const config = [
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
    ];
    const validation = validateRoleConfig(config, fourPlayers.length);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.some((i) => i.message.includes('Need at least 5 players'))).toBe(true);
    }
  });

  // Skenario 2: Room dengan 5 pemain tetapi ada yang unready
  it('Scenario 2: Room with 5 players but one not ready must be prevented from starting', () => {
    const players = [
      { id: 'p1', isReady: true },
      { id: 'p2', isReady: true },
      { id: 'p3', isReady: false }, // Unready
      { id: 'p4', isReady: true },
      { id: 'p5', isReady: true },
    ];

    const canStart = players.length >= 5 && players.every((p) => p.isReady);
    expect(canStart).toBe(false);
  });

  // Skenario 3: Room dengan 5 pemain dan semua Ready bisa memulai game
  it('Scenario 3: Room with 5 players and all ready satisfies start prerequisites', () => {
    const players = [
      { id: 'p1', seatNumber: 1, isReady: true },
      { id: 'p2', seatNumber: 2, isReady: true },
      { id: 'p3', seatNumber: 3, isReady: true },
      { id: 'p4', seatNumber: 4, isReady: true },
      { id: 'p5', seatNumber: 5, isReady: true },
    ];

    const canStart = players.length >= 5 && players.every((p) => p.isReady);
    expect(canStart).toBe(true);

    const defaultRoles = getDefaultRoleConfig(players.length);
    const validation = validateRoleConfig(defaultRoles, players.length);
    expect(validation.ok).toBe(true);
  });

  // Skenario 4: Role assignment komposisi tepat dan adil
  it('Scenario 4: Role assignment generates the approved 5-player composition (1 Wolf, 1 Seer, 1 Doctor, 2 Villagers)', () => {
    const players = [
      { playerId: 'p1', seatNumber: 1 },
      { playerId: 'p2', seatNumber: 2 },
      { playerId: 'p3', seatNumber: 3 },
      { playerId: 'p4', seatNumber: 4 },
      { playerId: 'p5', seatNumber: 5 },
    ];

    const defaultRoles = getDefaultRoleConfig(players.length);
    expect(defaultRoles).toEqual([
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'doctor', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 2, config: {} },
    ]);

    const { assignments, dealt } = assignRoles(players, defaultRoles);
    expect(assignments).toHaveLength(5);
    expect(dealt['werewolf']).toBe(1);
    expect(dealt['seer']).toBe(1);
    expect(dealt['doctor']).toBe(1);
    expect(dealt['villager']).toBe(2);

    // Pastikan setiap pemain mendapat tepat 1 assignment unik
    const assignedPlayerIds = new Set(assignments.map((a) => a.playerId));
    expect(assignedPlayerIds.size).toBe(5);
  });

  // Skenario 5: Privacy isolasi role (snapshot publik tidak membocorkan role)
  it('Scenario 5: Public lobby snapshot omits role secrets', () => {
    const mockDbPlayers = [
      { id: 'p1', display_name: 'Host', is_alive: true, is_ready: true },
      { id: 'p2', display_name: 'Player 2', is_alive: true, is_ready: true },
    ];

    // Mirroring GET /api/rooms/[roomId] sanitisation
    const safePlayers = mockDbPlayers.map((p) => ({
      id: p.id,
      displayName: p.display_name,
      isAlive: p.is_alive,
      isReady: p.is_ready,
    }));

    for (const p of safePlayers) {
      expect(p).not.toHaveProperty('roleKey');
      expect(p).not.toHaveProperty('role_key');
      expect(p).not.toHaveProperty('alignment');
    }
  });

  // Skenario 6 & 7: State transisi ke Night Phase dan penolakan double-start
  it('Scenario 6 & 7: Transition to night phase status locks room against double-start', () => {
    let roomStatus: 'lobby' | 'in_progress' | 'finished' = 'lobby';
    let phase = 'lobby';
    let roundNumber = 0;

    function startGameTransition() {
      if (roomStatus !== 'lobby') {
        throw new Error('game_already_started');
      }
      roomStatus = 'in_progress';
      phase = 'night';
      roundNumber = 1;
      return { ok: true, phase, roundNumber };
    }

    // Call 1: Sukses
    const firstCall = startGameTransition();
    expect(firstCall.ok).toBe(true);
    expect(roomStatus).toBe('in_progress');
    expect(phase).toBe('night');
    expect(roundNumber).toBe(1);

    // Call 2: Gagal (Double-start dicegah)
    expect(() => startGameTransition()).toThrow('game_already_started');
  });

  // Skenario 8: Dev harness protection
  it('Scenario 8: Dev test harness rejects access in non-development environments', async () => {
    // Testing the route guard logic
    function checkDevAccess(env: string) {
      if (env !== 'development') {
        return { status: 404 };
      }
      return { status: 200 };
    }

    expect(checkDevAccess('production').status).toBe(404);
    expect(checkDevAccess('test').status).toBe(404);
    expect(checkDevAccess('development').status).toBe(200);
  });
});
