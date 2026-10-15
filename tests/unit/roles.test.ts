import { describe, expect, it } from 'vitest';

import { validateRoleConfig } from '@/lib/game/config-validation';
import { getDefaultRoleConfig } from '@/lib/game/default-roles';
import { assignRoles, secureShuffle, type Rng } from '@/lib/game/role-assignment';
import {
  getRole,
  isRegisteredRole,
  listRoleKeys,
  listRoles,
  requireRole,
  roleSupportsAction,
} from '@/lib/game/role-registry';

/** Deterministic RNG so distribution assertions are reproducible. */
function seededRng(seed = 42): Rng {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, seatNumber: i + 1 }));

describe('role registry', () => {
  it('registers exactly the MVP roles', () => {
    expect(listRoleKeys().sort()).toEqual(['guardian_angel', 'hunter', 'lycan', 'mayor', 'seer', 'tanner', 'villager', 'werewolf']);
  });

  it('every role has the full definition the PRD requires', () => {
    for (const role of listRoles()) {
      expect(role.roleKey).toBeTruthy();
      expect(role.displayName).toBeTruthy();
      expect(role.alignment).toBeTruthy();
      expect(role.description).toBeTruthy();
      expect(role.configSchema).toBeDefined();
      expect(role.targetRules).toBeDefined();
      // A role with a night action must declare a priority; one without must not.
      if (role.nightAction === null) {
        expect(role.actionPriority).toBeNull();
      } else {
        expect(typeof role.actionPriority).toBe('number');
      }
    }
  });

  it('rejects an unregistered role rather than guessing', () => {
    expect(isRegisteredRole('serial_killer')).toBe(false);
    expect(getRole('serial_killer')).toBeUndefined();
    expect(() => requireRole('serial_killer')).toThrow(/Unknown role key/);
  });

  it('maps capabilities to the right actions', () => {
    expect(roleSupportsAction('werewolf', 'eliminate')).toBe(true);
    expect(roleSupportsAction('seer', 'investigate')).toBe(true);
    expect(roleSupportsAction('guardian_angel', 'protect')).toBe(true);
    // No role may perform an action that is not its own.
    expect(roleSupportsAction('villager', 'eliminate')).toBe(false);
    expect(roleSupportsAction('seer', 'protect')).toBe(false);
    expect(roleSupportsAction('werewolf', 'investigate')).toBe(false);
    expect(roleSupportsAction('guardian_angel', 'eliminate')).toBe(false);
  });

  it('resolves protection above elimination in priority', () => {
    const doctor = requireRole('guardian_angel');
    const werewolf = requireRole('werewolf');
    expect(doctor.actionPriority!).toBeGreaterThan(werewolf.actionPriority!);
  });
});

describe('role assignment', () => {
  it('deals exactly the configured number of each role', () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 2, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
    ];
    const result = assignRoles(players(7), config, seededRng());

    expect(result.assignments).toHaveLength(7);
    expect(result.dealt).toEqual({ werewolf: 2, villager: 3, seer: 1, guardian_angel: 1 });
  });

  it('assigns every player exactly one role, with the right alignment', () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 2, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
    ];
    const { assignments } = assignRoles(players(7), config, seededRng());

    const ids = assignments.map((a) => a.playerId);
    expect(new Set(ids).size).toBe(7);

    for (const assignment of assignments) {
      expect(assignment.alignment).toBe(requireRole(assignment.roleKey).alignment);
    }
    expect(assignments.filter((a) => a.alignment === 'werewolf')).toHaveLength(2);
  });

  it('throws when the role total does not match the player count', () => {
    const config = [{ roleKey: 'villager', roleCount: 5, config: {} }];
    expect(() => assignRoles(players(4), config, seededRng())).toThrow(/must be equal/);
  });

  it('refuses to assign an unregistered role', () => {
    const config = [{ roleKey: 'dragon', roleCount: 5, config: {} }];
    expect(() => assignRoles(players(5), config, seededRng())).toThrow(/Unknown role key/);
  });

  it('refuses a negative or fractional role count', () => {
    expect(() => assignRoles(players(2), [{ roleKey: 'villager', roleCount: -1, config: {} }])).toThrow(
      RangeError,
    );
    expect(() => assignRoles(players(2), [{ roleKey: 'villager', roleCount: 1.5, config: {} }])).toThrow(
      RangeError,
    );
  });

  it('actually shuffles: repeated runs differ', () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 3, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
    ];
    const roster = players(6);

    const first = assignRoles(roster, config).assignments.map((a) => a.roleKey).join(',');
    let sawDifferent = false;
    for (let i = 0; i < 12 && !sawDifferent; i += 1) {
      const next = assignRoles(roster, config).assignments.map((a) => a.roleKey).join(',');
      if (next !== first) sawDifferent = true;
    }
    expect(sawDifferent).toBe(true);
  });

  it('does not mutate the input array', () => {
    const roster = players(4);
    const snapshot = [...roster];
    assignRoles(roster, [{ roleKey: 'villager', roleCount: 4, config: {} }]);
    expect(roster).toEqual(snapshot);
  });
});

describe('secureShuffle', () => {
  it('preserves every element exactly once', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = secureShuffle(input, seededRng(7));
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it('is a permutation, not a copy with a changed order of probability', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = secureShuffle(input, seededRng(99));
    expect(shuffled).toHaveLength(input.length);
    expect(new Set(shuffled).size).toBe(input.length);
  });

  it('handles empty and single-element inputs', () => {
    expect(secureShuffle([], seededRng())).toEqual([]);
    expect(secureShuffle(['x'], seededRng())).toEqual(['x']);
  });
});

describe('validateRoleConfig', () => {
  const valid = [
    { roleKey: 'werewolf', roleCount: 2, config: {} },
    { roleKey: 'villager', roleCount: 3, config: {} },
    { roleKey: 'seer', roleCount: 1, config: {} },
    { roleKey: 'guardian_angel', roleCount: 1, config: {} },
  ];

  it('accepts a well-formed configuration', () => {
    const result = validateRoleConfig(valid, 7);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.reduce((sum, e) => sum + e.roleCount, 0)).toBe(7);
    }
  });

  it('rejects an unregistered role', () => {
    const result = validateRoleConfig([{ roleKey: 'dragon', roleCount: 7, config: {} }], 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('Unknown role'))).toBe(true);
    }
  });

  it('rejects a role total that does not equal the player count', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 2, config: {} },
        { roleKey: 'villager', roleCount: 2, config: {} },
      ],
      7,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('total 4'))).toBe(true);
    }
  });

  it('rejects a config with no werewolf', () => {
    const result = validateRoleConfig([{ roleKey: 'villager', roleCount: 7, config: {} }], 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('At least one Werewolf'))).toBe(true);
    }
  });

  it('rejects a config with no village player', () => {
    const result = validateRoleConfig([{ roleKey: 'werewolf', roleCount: 7, config: {} }], 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('non-werewolf'))).toBe(true);
    }
  });

  it('rejects a negative role count', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: -1, config: {} },
        { roleKey: 'villager', roleCount: 8, config: {} },
      ],
      7,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects too few players to start', () => {
    const result = validateRoleConfig([{ roleKey: 'werewolf', roleCount: 1, config: {} }], 2);
    expect(result.ok).toBe(false);
  });

  it('rejects more players than the room capacity', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 11, config: {} },
        { roleKey: 'villager', roleCount: 10, config: {} },
      ],
      21,
    );
    expect(result.ok).toBe(false);
  });

  it('drops zero-count entries from the normalised output', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 2, config: {} },
        { roleKey: 'villager', roleCount: 5, config: {} },
        { roleKey: 'seer', roleCount: 0, config: {} },
      ],
      7,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.map((e) => e.roleKey).sort()).toEqual(['villager', 'werewolf']);
    }
  });

  it('sums duplicate role keys instead of silently overwriting', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 2, config: {} },
        { roleKey: 'villager', roleCount: 3, config: {} },
        { roleKey: 'villager', roleCount: 2, config: {} },
      ],
      7,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const villager = result.config.find((e) => e.roleKey === 'villager');
      expect(villager?.roleCount).toBe(5);
    }
  });

  it('rejects a per-role config that fails the role schema', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 2, config: {} },
        { roleKey: 'villager', roleCount: 5, config: {} },
        // `reveal` is not a villager option and villager's schema is strict.
        { roleKey: 'seer', roleCount: 0, config: { nonsense: true } },
      ],
      7,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts an empty per-role config', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 2, config: {} },
        { roleKey: 'villager', roleCount: 4, config: {} },
        { roleKey: 'seer', roleCount: 1, config: {} },
      ],
      7,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No hidden defaults are invented: the config is exactly what was sent.
      for (const entry of result.config) {
        expect(entry.config).toEqual({});
      }
    }
  });

  it('rejects the removed werewolf requireUnanimous option', () => {
    // `requireUnanimous` was accepted and persisted but never read by the engine
    // or the RPC — plurality with a lowest-seat tie-break is the rule. An option
    // that silently does nothing is worse than no option.
    const result = validateRoleConfig(
      [{ roleKey: 'werewolf', roleCount: 1, config: { requireUnanimous: true } }],
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.path.startsWith('roles.werewolf.config')),
      ).toBe(true);
    }
  });

  it('rejects the removed seer reveal option', () => {
    // `reveal: 'role' | 'alignment'` was accepted and persisted but the Seer has
    // only ever reported ALIGNMENT; `'role'` was silently ignored.
    const result = validateRoleConfig(
      [{ roleKey: 'seer', roleCount: 1, config: { reveal: 'role' } }],
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.startsWith('roles.seer.config'))).toBe(true);
    }
  });

  it('still accepts every implemented role with no configuration', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 1, config: {} },
        { roleKey: 'seer', roleCount: 1, config: {} },
        { roleKey: 'guardian_angel', roleCount: 1, config: {} },
        { roleKey: 'villager', roleCount: 2, config: {} },
      ],
      5,
    );
    expect(result.ok).toBe(true);
  });

  it('warns when the wolves start at or above parity', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 3, config: {} },
        { roleKey: 'villager', roleCount: 3, config: {} },
      ],
      6,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes('parity'))).toBe(true);
    }
  });

  it('warns about a single Werewolf at the five-player minimum', () => {
    // The parity warning cannot see this case: 1 werewolf of 5 is `2 >= 5`,
    // i.e. false. But a lone wolf must survive to parity to win, so one correct
    // vote ends the game — the host deserves to know.
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 1, config: {} },
        { roleKey: 'seer', roleCount: 1, config: {} },
        { roleKey: 'guardian_angel', roleCount: 1, config: {} },
        { roleKey: 'villager', roleCount: 2, config: {} },
      ],
      5,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes('single Werewolf'))).toBe(true);
      // It is a warning, never a blocker: the config is still returned intact.
      expect(result.config.reduce((n, e) => n + e.roleCount, 0)).toBe(5);
    }
  });

  it('does not warn about a single Werewolf once the roster grows past the minimum', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 1, config: {} },
        { roleKey: 'seer', roleCount: 1, config: {} },
        { roleKey: 'guardian_angel', roleCount: 1, config: {} },
        { roleKey: 'villager', roleCount: 3, config: {} },
      ],
      6,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes('single Werewolf'))).toBe(false);
    }
  });

  it('rejects a four-player roster outright', () => {
    const result = validateRoleConfig(
      [
        { roleKey: 'werewolf', roleCount: 1, config: {} },
        { roleKey: 'villager', roleCount: 3, config: {} },
      ],
      4,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('Need at least 5 players'))).toBe(true);
    }
  });

  it('getDefaultRoleConfig produces the approved five-player composition', () => {
    expect(getDefaultRoleConfig(5)).toEqual([
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 2, config: {} },
    ]);
  });

  it('getDefaultRoleConfig refuses fewer than five players', () => {
    expect(() => getDefaultRoleConfig(4)).toThrow(/Minimum players .* is 5/);
  });
});
