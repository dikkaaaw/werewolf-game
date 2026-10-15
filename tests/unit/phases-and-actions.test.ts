// @vitest/ssr
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { handleInsertResultError } from '@/lib/server/phase-advancement';
import { validateNightAction } from '@/lib/game/action-validation';
import {
  assertLegalTransition,
  computePhaseDeadline,
  decideNextPhase,
  isActivePhase,
  isLegalTransition,
  isPhaseExpired,
  legalTransitions,
  phaseDurationSeconds,
} from '@/lib/game/phase-manager';
import { SETTINGS } from '@/lib/game/settings';
import type { PlayerState } from '@/lib/game/types';

const base: PlayerState = {
  playerId: 'p1',
  userId: 'u1',
  seatNumber: 1,
  displayName: 'One',
  isAlive: true,
  alignment: 'werewolf',
  roleKey: 'werewolf',
};

const target: PlayerState = {
  playerId: 'p2',
  userId: 'u2',
  seatNumber: 2,
  displayName: 'Two',
  isAlive: true,
  alignment: 'village',
  roleKey: 'villager',
};

function actionInput(overrides: Partial<Parameters<typeof validateNightAction>[0]> = {}) {
  return {
    actor: base,
    target,
    actionType: 'eliminate' as const,
    phase: 'night' as const,
    roomStatus: 'in_progress' as const,
    phaseExpired: false,
    ...overrides,
  };
}

describe('phase state machine', () => {
  it('allows exactly the PRD transitions', () => {
    expect(isLegalTransition('lobby', 'night')).toBe(true);
    expect(isLegalTransition('night', 'day')).toBe(true);
    expect(isLegalTransition('night', 'finished')).toBe(true);
    expect(isLegalTransition('day', 'voting')).toBe(true);
    expect(isLegalTransition('voting', 'night')).toBe(true);
    expect(isLegalTransition('voting', 'finished')).toBe(true);
  });

  it('rejects every other transition', () => {
    const illegal: Array<[Parameters<typeof isLegalTransition>[0], Parameters<typeof isLegalTransition>[1]]> = [
      ['lobby', 'day'],
      ['lobby', 'voting'],
      ['lobby', 'finished'],
      ['night', 'voting'],
      ['night', 'lobby'],
      ['day', 'night'],
      ['day', 'finished'],
      ['voting', 'day'],
      ['finished', 'night'],
      ['finished', 'day'],
      ['finished', 'voting'],
    ];
    for (const [from, to] of illegal) {
      expect(isLegalTransition(from, to), `${from} -> ${to} must be illegal`).toBe(false);
    }
  });

  it('a finished game has no outgoing transitions', () => {
    expect(legalTransitions('finished')).toEqual([]);
  });

  it('assertLegalTransition throws on an illegal move', () => {
    expect(() => assertLegalTransition('day', 'night')).toThrow(/Illegal phase transition/);
    expect(() => assertLegalTransition('night', 'day')).not.toThrow();
  });
});

describe('phase deadlines', () => {
  it('only active phases carry a deadline', () => {
    expect(isActivePhase('night')).toBe(true);
    expect(isActivePhase('day')).toBe(true);
    expect(isActivePhase('voting')).toBe(true);
    expect(isActivePhase('lobby')).toBe(false);
    expect(isActivePhase('finished')).toBe(false);
  });

  it('computes a deadline from the server clock', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const deadline = computePhaseDeadline('night', start);

    expect(deadline?.toISOString()).toBe(
      new Date(start.getTime() + SETTINGS.phaseSeconds.night * 1000).toISOString(),
    );
  });

  it('gives lobby and finished no deadline', () => {
    const start = new Date();
    expect(computePhaseDeadline('lobby', start)).toBeNull();
    expect(computePhaseDeadline('finished', start)).toBeNull();
  });

  it('clamps an out-of-range override instead of trusting it', () => {
    expect(phaseDurationSeconds('night', { night: 5 })).toBe(
      SETTINGS.phaseSecondsBounds.night.min,
    );
    expect(phaseDurationSeconds('night', { night: 99_999 })).toBe(
      SETTINGS.phaseSecondsBounds.night.max,
    );
    expect(phaseDurationSeconds('night', { night: Number.NaN })).toBe(
      SETTINGS.phaseSeconds.night,
    );
  });

  it('treats the deadline as expired at exactly the boundary', () => {
    const now = new Date('2026-01-01T00:01:00.000Z');
    expect(isPhaseExpired('2026-01-01T00:01:00.000Z', now)).toBe(true);
    expect(isPhaseExpired('2026-01-01T00:01:00.001Z', now)).toBe(false);
    expect(isPhaseExpired(null, now)).toBe(false);
  });
});

describe('decideNextPhase', () => {
  it('night -> day keeps the round number', () => {
    expect(decideNextPhase({ from: 'night', roundNumber: 1, gameOver: false })).toMatchObject({
      nextPhase: 'day',
      roundNumber: 1,
    });
  });

  it('day -> voting keeps the round number', () => {
    expect(decideNextPhase({ from: 'day', roundNumber: 3, gameOver: false })).toMatchObject({
      nextPhase: 'voting',
      roundNumber: 3,
    });
  });

  it('voting -> night increments the round number', () => {
    expect(decideNextPhase({ from: 'voting', roundNumber: 3, gameOver: false })).toMatchObject({
      nextPhase: 'night',
      roundNumber: 4,
    });
  });

  it('a night, its day and its voting phase all share one round number', () => {
    // GAME-RULES §3: the round advances only on `voting -> night`, so the first
    // night, the first day and the first voting phase are all round 1. This is
    // the corrected convention (an earlier draft of the doc claimed the first
    // voting phase was round 2, which contradicted its own rule).
    expect(decideNextPhase({ from: 'night', roundNumber: 1, gameOver: false })).toMatchObject({
      nextPhase: 'day',
      roundNumber: 1,
    });
    expect(decideNextPhase({ from: 'day', roundNumber: 1, gameOver: false })).toMatchObject({
      nextPhase: 'voting',
      roundNumber: 1,
    });
    expect(decideNextPhase({ from: 'voting', roundNumber: 1, gameOver: false })).toMatchObject({
      nextPhase: 'night',
      roundNumber: 2,
    });
  });

  it('finishes from night or voting when the game is over', () => {
    expect(decideNextPhase({ from: 'night', roundNumber: 2, gameOver: true }).nextPhase).toBe('finished');
    expect(decideNextPhase({ from: 'voting', roundNumber: 2, gameOver: true }).nextPhase).toBe('finished');
  });

  it('cannot finish from day (only a resolution may end the game)', () => {
    expect(() => decideNextPhase({ from: 'day', roundNumber: 1, gameOver: true })).toThrow(
      /Illegal phase transition/,
    );
  });

  it('cannot advance from lobby or finished', () => {
    expect(() => decideNextPhase({ from: 'lobby', roundNumber: 0, gameOver: false })).toThrow();
    expect(() => decideNextPhase({ from: 'finished', roundNumber: 4, gameOver: false })).toThrow();
  });

  it('produces a duration for the next active phase only', () => {
    expect(decideNextPhase({ from: 'night', roundNumber: 1, gameOver: false }).durationSeconds).toBe(
      SETTINGS.phaseSeconds.day,
    );
    expect(
      decideNextPhase({ from: 'voting', roundNumber: 1, gameOver: true }).durationSeconds,
    ).toBe(0);
  });
});

describe('validateNightAction', () => {
  it('accepts a valid werewolf elimination', () => {
    expect(validateNightAction(actionInput())).toEqual({ ok: true });
  });

  it('rejects a role with no night action', () => {
    const villager = { ...base, roleKey: 'villager', alignment: 'village' as const };
    const result = validateNightAction(actionInput({ actor: villager }));

    expect(result).toMatchObject({ ok: false, code: 'role_cannot_act' });
  });

  it('rejects an action the role does not have', () => {
    const result = validateNightAction(actionInput({ actionType: 'investigate' }));

    expect(result).toMatchObject({ ok: false, code: 'action_not_supported_by_role' });
  });

  it('rejects an action outside the night phase', () => {
    for (const phase of ['lobby', 'day', 'voting', 'finished'] as const) {
      expect(validateNightAction(actionInput({ phase }))).toMatchObject({
        ok: false,
        code: 'wrong_phase',
      });
    }
  });

  it('rejects an action after the server-side deadline', () => {
    expect(validateNightAction(actionInput({ phaseExpired: true }))).toMatchObject({
      ok: false,
      code: 'phase_expired',
    });
  });

  it('rejects an action when the game is not running', () => {
    expect(validateNightAction(actionInput({ roomStatus: 'lobby' }))).toMatchObject({
      ok: false,
      code: 'room_not_in_progress',
    });
  });

  it('rejects a dead player', () => {
    const dead = { ...base, isAlive: false };
    expect(validateNightAction(actionInput({ actor: dead }))).toMatchObject({
      ok: false,
      code: 'player_not_alive',
    });
  });

  it('rejects a non-member', () => {
    expect(validateNightAction(actionInput({ actor: undefined }))).toMatchObject({
      ok: false,
      code: 'player_not_in_room',
    });
  });

  it('rejects targeting yourself', () => {
    expect(validateNightAction(actionInput({ target: base }))).toMatchObject({
      ok: false,
      code: 'target_is_self',
    });
  });

  it('rejects targeting a dead player', () => {
    const deadTarget = { ...target, isAlive: false };
    expect(validateNightAction(actionInput({ target: deadTarget }))).toMatchObject({
      ok: false,
      code: 'target_dead',
    });
  });

  it('rejects a target who is not in the room', () => {
    expect(validateNightAction(actionInput({ target: undefined }))).toMatchObject({
      ok: false,
      code: 'target_not_in_room',
    });
  });

  it('enforces forbidRepeatTarget for the doctor', () => {
    const doctor = { ...base, roleKey: 'guardian_angel', alignment: 'village' as const };
    const input = actionInput({
      actor: doctor,
      actionType: 'protect',
      previousTargetPlayerId: 'p2',
    });

    expect(validateNightAction(input)).toMatchObject({
      ok: false,
      code: 'repeat_target_forbidden',
    });
    expect(validateNightAction({ ...input, previousTargetPlayerId: 'p9' })).toEqual({ ok: true });
  });

  it('A1: refuses a Werewolf targeting another Werewolf', () => {
    const wolfA = { ...base, roleKey: 'werewolf', alignment: 'werewolf' as const };
    const wolfB = { ...target, playerId: 'p2', roleKey: 'werewolf', alignment: 'werewolf' as const };

    expect(
      validateNightAction(actionInput({ actor: wolfA, actionType: 'eliminate', target: wolfB })),
    ).toMatchObject({ ok: false, code: 'same_role_target_forbidden' });
  });

  it('A1: still allows a Werewolf to target an eligible non-Werewolf', () => {
    const wolf = { ...base, roleKey: 'werewolf', alignment: 'werewolf' as const };
    const villager = { ...target, playerId: 'p2', roleKey: 'villager', alignment: 'village' as const };

    expect(
      validateNightAction(actionInput({ actor: wolf, actionType: 'eliminate', target: villager })),
    ).toEqual({ ok: true });
  });

  it('A2: refuses a Doctor protecting another Doctor', () => {
    const docA = { ...base, roleKey: 'guardian_angel', alignment: 'village' as const };
    const docB = { ...target, playerId: 'p2', roleKey: 'guardian_angel', alignment: 'village' as const };

    expect(
      validateNightAction(actionInput({ actor: docA, actionType: 'protect', target: docB })),
    ).toMatchObject({ ok: false, code: 'same_role_target_forbidden' });
  });

  it('A2: still allows a Doctor to protect an eligible non-Doctor', () => {
    const doc = { ...base, roleKey: 'guardian_angel', alignment: 'village' as const };
    const seer = { ...target, playerId: 'p2', roleKey: 'seer', alignment: 'village' as const };

    expect(
      validateNightAction(actionInput({ actor: doc, actionType: 'protect', target: seer })),
    ).toEqual({ ok: true });
  });

  it('still allows a Seer to investigate another Seer', () => {
    const seerA = { ...base, roleKey: 'seer', alignment: 'village' as const };
    const seerB = { ...target, playerId: 'p2', roleKey: 'seer', alignment: 'village' as const };

    expect(
      validateNightAction(actionInput({ actor: seerA, actionType: 'investigate', target: seerB })),
    ).toEqual({ ok: true });
  });

  it('keeps the same-role rule distinct from self-targeting and repeat-target', () => {
    const wolf = { ...base, roleKey: 'werewolf', alignment: 'werewolf' as const };
    // Self-target is reported as target_is_self, not same_role_target_forbidden.
    expect(
      validateNightAction(actionInput({ actor: wolf, actionType: 'eliminate', target: wolf })),
    ).toMatchObject({ ok: false, code: 'target_is_self' });

    // Same-role targeting does not depend on the previous-round target.
    const wolfB = { ...target, playerId: 'p2', roleKey: 'werewolf', alignment: 'werewolf' as const };
    expect(
      validateNightAction(
        actionInput({ actor: wolf, actionType: 'eliminate', target: wolfB, previousTargetPlayerId: 'p9' }),
      ),
    ).toMatchObject({ ok: false, code: 'same_role_target_forbidden' });
  });

  it('refuses doctor self-protection unconditionally (MVP has no override)', () => {
    // The `allowSelfProtect` role-config flag was removed: it defaulted to
    // false and the authoritative `submit_night_action` RPC rejected
    // self-targets regardless, so it could never do anything except mislead.
    // Self-protection is a rule change, not a config value.
    const doctor = { ...base, roleKey: 'guardian_angel', alignment: 'village' as const };
    const selfTarget = { ...doctor, playerId: 'p1' };

    expect(
      validateNightAction(actionInput({ actor: doctor, actionType: 'protect', target: selfTarget })),
    ).toMatchObject({ ok: false, code: 'target_is_self' });

    // Every acting role is equally locked out of self-targeting. Each uses its
    // OWN action type, because capability is checked before target legality —
    // a villager has no action at all and never reaches the self-target rule.
    const acting: Array<[typeof base.roleKey, 'eliminate' | 'investigate' | 'protect']> = [
      ['werewolf', 'eliminate'],
      ['seer', 'investigate'],
      ['guardian_angel', 'protect'],
    ];
    for (const [roleKey, actionType] of acting) {
      const actor = { ...base, roleKey, alignment: 'village' as const };
      expect(
        validateNightAction(
          actionInput({ actor, actionType, target: { ...actor, playerId: 'p1' } }),
        ),
      ).toMatchObject({ ok: false, code: 'target_is_self' });
    }

    // The villager is rejected earlier, on capability.
    const villager = { ...base, roleKey: 'villager', alignment: 'village' as const };
    expect(
      validateNightAction(
        actionInput({
          actor: villager,
          actionType: 'eliminate',
          target: { ...villager, playerId: 'p1' },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'role_cannot_act' });
  });

  it('checks room/phase before capability so the message is not misleading', () => {
    const villager = { ...base, roleKey: 'villager', alignment: 'village' as const };
    const result = validateNightAction(actionInput({ actor: villager, phase: 'day' }));

    expect(result).toMatchObject({ ok: false, code: 'wrong_phase' });
  });
});

// ----- F3 – Seer result idempotency under duplicate-key handling -----
describe('F3 – Seer result idempotency', () => {
  const ACTION_ID = 'action-id-1';
  const TARGET_ID = 'player-1';
  const ALIGNMENT = 'villager';

  /**
   * Minimal stand-in for the admin client's query builder. It records the
   * filters the helper applies so the test can assert the read is scoped to
   * the exact (action_id, result_type) conflict rather than a broad scan.
   */
  function readerReturning(payload: unknown, readError: unknown = null) {
    const eq = vi.fn();
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const maybeSingle = vi.fn().mockResolvedValue({
      data: readError ? null : { result_payload: payload },
      error: readError,
    });
    eq.mockReturnValue({ eq, maybeSingle });
    return { client: { from }, from, select, eq, maybeSingle };
  }

  it('accepts a successful insert without reading anything back', async () => {
    const r = readerReturning(null);
    await expect(
      handleInsertResultError(r.client, null, ACTION_ID, TARGET_ID, ALIGNMENT),
    ).resolves.toBeUndefined();
    expect(r.from).not.toHaveBeenCalled();
  });

  it('treats a 23505 as idempotent only after reading back a matching payload', async () => {
    const r = readerReturning({ targetPlayerId: TARGET_ID, alignment: ALIGNMENT });
    await expect(
      handleInsertResultError(
        r.client,
        { code: '23505' },
        ACTION_ID,
        TARGET_ID,
        ALIGNMENT,
      ),
    ).resolves.toBeUndefined();
  });

  it('scopes the read-back to the conflicting action_id and result_type', async () => {
    const r = readerReturning({ targetPlayerId: TARGET_ID, alignment: ALIGNMENT });
    await handleInsertResultError(
      r.client,
      { code: '23505' },
      ACTION_ID,
      TARGET_ID,
      ALIGNMENT,
    );
    expect(r.from).toHaveBeenCalledWith('game_action_results');
    expect(r.select).toHaveBeenCalledWith('result_payload');
    expect(r.eq).toHaveBeenNthCalledWith(1, 'action_id', ACTION_ID);
    expect(r.eq).toHaveBeenNthCalledWith(2, 'result_type', 'investigate');
    expect(r.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate whose stored target player disagrees', async () => {
    const r = readerReturning({ targetPlayerId: 'player-2', alignment: ALIGNMENT });
    await expect(
      handleInsertResultError(r.client, { code: '23505' }, ACTION_ID, TARGET_ID, ALIGNMENT),
    ).rejects.toThrow('Seer result idempotency check failed');
  });

  it('rejects a duplicate whose stored alignment disagrees', async () => {
    const r = readerReturning({ targetPlayerId: TARGET_ID, alignment: 'werewolf' });
    await expect(
      handleInsertResultError(r.client, { code: '23505' }, ACTION_ID, TARGET_ID, ALIGNMENT),
    ).rejects.toThrow('Seer result idempotency check failed');
  });

  it('rejects a 23505 when no conflicting row can be read back', async () => {
    const r = readerReturning(null);
    await expect(
      handleInsertResultError(r.client, { code: '23505' }, ACTION_ID, TARGET_ID, ALIGNMENT),
    ).rejects.toThrow('Seer result idempotency check failed');
  });

  it('propagates a failure of the read-back query itself', async () => {
    const r = readerReturning(null, { message: 'permission denied' });
    await expect(
      handleInsertResultError(r.client, { code: '23505' }, ACTION_ID, TARGET_ID, ALIGNMENT),
    ).rejects.toThrow('permission denied');
  });

  it('propagates any non-23505 insert error without consulting the database', async () => {
    const r = readerReturning(null);
    await expect(
      handleInsertResultError(
        r.client,
        { code: '23503', message: 'foreign key violation' },
        ACTION_ID,
        TARGET_ID,
        ALIGNMENT,
      ),
    ).rejects.toThrow('foreign key violation');
    expect(r.from).not.toHaveBeenCalled();
  });
});
