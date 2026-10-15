import { describe, expect, it } from 'vitest';

import {
  getRoleTeamLabel,
  getSecretRolePresentation,
  NEUTRAL_PALETTE,
  hasSecretRole,
  initialSecretRoleCardState,
  isSecretRoleCurrent,
  secretRoleCardReducer,
  secretRoleScope,
  assignSessionPalettes,
  resetSecretRolePaletteSession,
  ROLE_COLOR_PALETTES,
  SECRET_ROLE_IDENTITY,
  type SecretRoleAssignment,
  type SecretRoleCardState,
  type SecretRolePalette,
} from '@/lib/game/secret-role-card';

/**
 * The card is now hover-driven: no reveal timeline, no close/open cycle. What
 * is left is role ownership, scoping and presentation.
 */

const SCOPE_A = secretRoleScope('room-a', '2026-01-01T00:00:00Z');
const SCOPE_B = secretRoleScope('room-b', '2026-01-01T00:00:00Z');
const SCOPE_A_NEW_GAME = secretRoleScope('room-a', '2026-01-02T00:00:00Z');

const WEREWOLF: SecretRoleAssignment = { roleKey: 'werewolf', alignment: 'werewolf' };
const SEER: SecretRoleAssignment = { roleKey: 'seer', alignment: 'village' };

function assigned(
  state: SecretRoleCardState,
  scope: string,
  role: SecretRoleAssignment = WEREWOLF,
): SecretRoleCardState {
  return secretRoleCardReducer(state, { type: 'role-assigned', scope, role });
}

describe('Secret role card — role ownership', () => {
  it('holds no role until one is assigned', () => {
    expect(initialSecretRoleCardState.roleKey).toBeNull();
    expect(initialSecretRoleCardState.alignment).toBeNull();
    expect(initialSecretRoleCardState.investigations).toEqual([]);
    expect(hasSecretRole(initialSecretRoleCardState)).toBe(false);
  });

  it('takes the role from the first assignment', () => {
    const state = assigned(initialSecretRoleCardState, SCOPE_A, WEREWOLF);

    expect(state.roleKey).toBe('werewolf');
    expect(state.alignment).toBe('werewolf');
    expect(state.scope).toBe(SCOPE_A);
    expect(hasSecretRole(state)).toBe(true);
  });

  it('defaults missing investigations to an empty list', () => {
    const state = assigned(initialSecretRoleCardState, SCOPE_A, { roleKey: 'villager', alignment: 'village' });
    expect(state.investigations).toEqual([]);
  });

  it('is driven purely by assignment and access loss', () => {
    // The only two actions that exist are the only two the room page sends.
    const state = assigned(initialSecretRoleCardState, SCOPE_A);
    const cleared = secretRoleCardReducer(state, { type: 'access-lost', scope: SCOPE_A });

    expect(cleared).toEqual(initialSecretRoleCardState);
  });
});

describe('Secret role card — refetch and realtime bursts', () => {
  it('returns the identical state when nothing changed', () => {
    // Returning a new object here would re-render the card on every Realtime
    // burst even though the role is the same.
    const first = assigned(initialSecretRoleCardState, SCOPE_A);
    const refetched = assigned(first, SCOPE_A);

    expect(refetched).toBe(first);
  });

  it('survives a burst of identical assignments unchanged', () => {
    const first = assigned(initialSecretRoleCardState, SCOPE_A);
    const afterBurst = [first, first, first, first].reduce(
      (state) => assigned(state, SCOPE_A),
      first,
    );

    expect(afterBurst).toBe(first);
    expect(afterBurst.roleKey).toBe('werewolf');
  });

  it('refreshes private Seer intel in place', () => {
    const seer = assigned(initialSecretRoleCardState, SCOPE_A, SEER);
    const withIntel = assigned(seer, SCOPE_A, {
      ...SEER,
      investigations: [{ roundNumber: 1, result: { targetPlayerId: 'p2', alignment: 'werewolf' } }],
    });

    expect(withIntel.roleKey).toBe('seer');
    expect(withIntel.investigations).toHaveLength(1);
    // Same identity fields, so only the intel changed.
    expect(withIntel).not.toBe(seer);
  });

  it('drops intel that a later snapshot no longer reports', () => {
    const seer = assigned(initialSecretRoleCardState, SCOPE_A, {
      ...SEER,
      investigations: [{ roundNumber: 1, result: { targetPlayerId: 'p2', alignment: 'werewolf' } }],
    });
    const cleared = assigned(seer, SCOPE_A, SEER);

    expect(cleared.investigations).toEqual([]);
  });

  it('detects a changed investigation result', () => {
    const seer = assigned(initialSecretRoleCardState, SCOPE_A, {
      ...SEER,
      investigations: [{ roundNumber: 1, result: { targetPlayerId: 'p2', alignment: 'werewolf' } }],
    });
    const updated = assigned(seer, SCOPE_A, {
      ...SEER,
      investigations: [{ roundNumber: 1, result: { targetPlayerId: 'p2', alignment: 'village' } }],
    });

    expect(updated).not.toBe(seer);
    expect(updated.investigations[0].result.alignment).toBe('village');
  });
});

describe('Secret role card — room and game scoping', () => {
  it('gives a different scope per room and per new game in the same room', () => {
    expect(SCOPE_A).not.toBe(SCOPE_B);
    expect(SCOPE_A).not.toBe(SCOPE_A_NEW_GAME);
  });

  it('reports a cached role as current only for its own scope', () => {
    const inRoomA = assigned(initialSecretRoleCardState, SCOPE_A);

    expect(isSecretRoleCurrent(inRoomA, SCOPE_A)).toBe(true);
    expect(isSecretRoleCurrent(inRoomA, SCOPE_B)).toBe(false);
    expect(isSecretRoleCurrent(inRoomA, null)).toBe(false);
  });

  it('is not current once the role is gone', () => {
    const cleared = secretRoleCardReducer(
      assigned(initialSecretRoleCardState, SCOPE_A),
      { type: 'access-lost', scope: SCOPE_A },
    );

    expect(isSecretRoleCurrent(cleared, SCOPE_A)).toBe(false);
  });

  it('replaces the role for a new game started in the same room', () => {
    const previousGame = assigned(initialSecretRoleCardState, SCOPE_A);
    const nextGame = assigned(previousGame, SCOPE_A_NEW_GAME, SEER);

    expect(nextGame.roleKey).toBe('seer');
    expect(nextGame.scope).toBe(SCOPE_A_NEW_GAME);
  });

  it('clears the cached secret when access to the room is lost', () => {
    const cleared = secretRoleCardReducer(
      assigned(initialSecretRoleCardState, SCOPE_A),
      { type: 'access-lost', scope: SCOPE_A },
    );

    expect(cleared).toEqual(initialSecretRoleCardState);
    expect(hasSecretRole(cleared)).toBe(false);
  });

  it('ignores an access loss reported for a different scope', () => {
    const inRoomA = assigned(initialSecretRoleCardState, SCOPE_A);
    const unrelated = secretRoleCardReducer(inRoomA, { type: 'access-lost', scope: SCOPE_B });

    expect(unrelated).toBe(inRoomA);
  });
});

describe('Secret role card — presentation', () => {
  it('gives every registered role a distinct emblem and title', () => {
    const identities = new Set(
      Object.values(SECRET_ROLE_IDENTITY).map((role) => role.title),
    );
    expect(identities.size).toBe(Object.keys(SECRET_ROLE_IDENTITY).length);
    expect(Object.keys(SECRET_ROLE_IDENTITY).sort()).toEqual([
      'guardian_angel',
      'lycan',
      'seer',
      'villager',
      'werewolf',
    ]);
  });

  it('resolves a neutral fallback for unknown or missing roles', () => {
    expect(getSecretRolePresentation('werewolf').emblem).toBe('werewolf');
    expect(getSecretRolePresentation('WEREWOLF').title).toBe('Werewolf');
    expect(getSecretRolePresentation(null).title).toBe('Villager');
    expect(getSecretRolePresentation('mystery-role').title).toBe('Villager');
  });

  it('labels the team from the private alignment only', () => {
    expect(getRoleTeamLabel('werewolf')).toBe('Werewolf Pack');
    expect(getRoleTeamLabel('village')).toBe('Village');
    expect(getRoleTeamLabel(null)).toBe('Unknown Allegiance');
  });

  it('describes every role ability', () => {
    for (const role of Object.values(SECRET_ROLE_IDENTITY)) {
      expect(role.title.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(20);
    }
  });
});

describe('Secret role card — colour is not a role fingerprint', () => {
  const ROLES = Object.keys(SECRET_ROLE_IDENTITY);

  it('has more colour treatments than roles', () => {
    // Otherwise a session could not shuffle the mapping at all.
    expect(ROLE_COLOR_PALETTES.length).toBeGreaterThan(ROLES.length);
  });

  it('gives every role a distinct colour within one session', () => {
    const palettes = assignSessionPalettes(ROLES, <T,>(items: readonly T[]) => items.slice());
    const seen = new Set(ROLES.map((role) => palettes[role].accentBorder));
    expect(seen.size).toBe(ROLES.length);
  });

  it('changes the role-to-colour mapping between sessions', () => {
    // The whole point: two sessions must not agree on what colour werewolf wears.
    const identity = <T,>(items: readonly T[]): T[] => items.slice();
    const reverse = <T,>(items: readonly T[]): T[] => items.slice().reverse();
    const forward = assignSessionPalettes(ROLES, identity);
    const backwards = assignSessionPalettes(ROLES, reverse);

    const mapping = (p: Record<string, SecretRolePalette>) =>
      ROLES.map((role) => p[role].accentBorder).join('|');

    expect(mapping(forward)).not.toBe(mapping(backwards));
  });

  it('does not always dress werewolf in the first palette', () => {
    // A fixed order would hand every session the same mapping.
    const rotate = <T,>(items: readonly T[]): T[] => items.slice(1).concat(items[0]);
    const shifted = assignSessionPalettes(ROLES, rotate);
    expect(shifted.werewolf).not.toBe(ROLE_COLOR_PALETTES[0]);
  });

  it('does not repaint the card on a re-read within the same session', () => {
    resetSecretRolePaletteSession();
    const first = getSecretRolePresentation('werewolf').accentBorder;
    const second = getSecretRolePresentation('werewolf').accentBorder;
    resetSecretRolePaletteSession();

    expect(second).toBe(first);
  });

  it('keeps colour off the unknown-role fallback', () => {
    // An unnamed role must not borrow a real role's colour.
    const unknown = getSecretRolePresentation('mystery-role');
    const knownColours = new Set(ROLE_COLOR_PALETTES.map((p) => p.accentBorder));
    expect(knownColours.has(unknown.accentBorder)).toBe(false);
    expect(unknown.accentBorder).toBe(NEUTRAL_PALETTE.accentBorder);
  });

  it('still shows the right copy for the role', () => {
    const werewolf = getSecretRolePresentation('werewolf');
    expect(werewolf.title).toBe('Werewolf');
    expect(werewolf.emblem).toBe('werewolf');
    expect(werewolf.description).toContain('pack');
  });
});
