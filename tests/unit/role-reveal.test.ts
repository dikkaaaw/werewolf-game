import { describe, expect, it } from 'vitest';

import { isRoleRevealed } from '@/lib/game/reveal';

/**
 * The reveal rule is the security boundary for public role disclosure, so these
 * tests are written as a truth table over (status, alive, setting) rather than
 * as a handful of happy paths. The row that matters most is the first block:
 * a LIVING player during an IN-PROGRESS game must never be revealed, whatever
 * the setting says.
 */
describe('isRoleRevealed', () => {
  describe('the core invariant: living players in an active game are never public', () => {
    const settings = [
      ['setting absent', undefined],
      ['setting true', true],
      ['setting false', false],
      ['setting "true"', 'true'],
      ['setting "false"', 'false'],
      ['setting garbage', 'yes-please'],
      ['setting null', null],
      ['setting 0', 0],
    ] as const;

    for (const [label, value] of settings) {
      it(`withholds a living player's role during an active game when ${label}`, () => {
        expect(
          isRoleRevealed({
            roomStatus: 'in_progress',
            revealRoleOnElimination: value,
            isAlive: true,
          }),
        ).toBe(false);
      });
    }

    it('withholds it for every non-terminal status, not just in_progress', () => {
      for (const status of ['lobby', 'in_progress', 'paused', 'whatever']) {
        expect(
          isRoleRevealed({ roomStatus: status, isAlive: true }),
          `status ${status} must not reveal a living player`,
        ).toBe(false);
      }
    });
  });

  describe('eliminated players during an active game', () => {
    it('reveals them when the setting is absent (the default is on)', () => {
      expect(isRoleRevealed({ roomStatus: 'in_progress', isAlive: false })).toBe(true);
    });

    it('reveals them when the setting is explicitly true', () => {
      expect(
        isRoleRevealed({
          roomStatus: 'in_progress',
          revealRoleOnElimination: true,
          isAlive: false,
        }),
      ).toBe(true);
    });

    it('withholds them when the setting is boolean false', () => {
      expect(
        isRoleRevealed({
          roomStatus: 'in_progress',
          revealRoleOnElimination: false,
          isAlive: false,
        }),
      ).toBe(false);
    });

    it('withholds them when the setting is the string "false"', () => {
      expect(
        isRoleRevealed({
          roomStatus: 'in_progress',
          revealRoleOnElimination: 'false',
          isAlive: false,
        }),
      ).toBe(false);
    });

    it('reveals them for an unrecognised value rather than failing closed', () => {
      // Only an explicit false withholds. Treating garbage as a privacy choice
      // would silently hide roles the rules say are public.
      expect(
        isRoleRevealed({
          roomStatus: 'in_progress',
          revealRoleOnElimination: 'nonsense',
          isAlive: false,
        }),
      ).toBe(true);
    });
  });

  describe('a finished game reveals everyone', () => {
    it('reveals a living player', () => {
      expect(isRoleRevealed({ roomStatus: 'finished', isAlive: true })).toBe(true);
    });

    it('reveals an eliminated player', () => {
      expect(isRoleRevealed({ roomStatus: 'finished', isAlive: false })).toBe(true);
    });

    it('reveals everyone even when revealRoleOnElimination is false', () => {
      // GAME-RULES §10 is unconditional at game end; the per-elimination
      // setting must not suppress the final board.
      expect(
        isRoleRevealed({
          roomStatus: 'finished',
          revealRoleOnElimination: false,
          isAlive: true,
        }),
      ).toBe(true);
      expect(
        isRoleRevealed({
          roomStatus: 'finished',
          revealRoleOnElimination: 'false',
          isAlive: false,
        }),
      ).toBe(true);
    });

    it('wins over a nonsense status, so the terminal check is evaluated first', () => {
      expect(
        isRoleRevealed({
          roomStatus: 'finished',
          revealRoleOnElimination: 'garbage',
          isAlive: true,
        }),
      ).toBe(true);
    });
  });
});