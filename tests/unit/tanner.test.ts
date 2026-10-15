import { describe, expect, it } from 'vitest';
import { getRole, requireRole, isRegisteredRole } from '@/lib/game/role-registry';
import { getRoleCharacterArtwork, hasRoleArtwork } from '@/lib/game/role-artwork';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { EDITABLE_ROLE_KEYS } from '@/lib/game/room-settings';

describe('Tanner role specification and registry', () => {
  it('is registered with neutral alignment and no night action', () => {
    expect(isRegisteredRole('tanner')).toBe(true);
    const role = requireRole('tanner');
    expect(role.roleKey).toBe('tanner');
    expect(role.displayName).toBe('Tanner');
    expect(role.alignment).toBe('neutral');
    expect(role.nightAction).toBeNull();
    expect(role.actionPriority).toBeNull();
    expect(role.countsForWinAs).toBe('neutral');
  });

  it('has character artwork mapped correctly', () => {
    expect(hasRoleArtwork('tanner')).toBe(true);
    expect(getRoleCharacterArtwork('tanner')).toBe('/assets/images/role-character/tanner.jpg');
  });

  it('is included in EDITABLE_ROLE_KEYS for lobby settings', () => {
    expect(EDITABLE_ROLE_KEYS).toContain('tanner');
  });

  it('validates as an acceptable role configuration', () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
      { roleKey: 'tanner', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 1, config: {} },
    ];
    const result = validateRoleConfig(config, 5);
    expect(result.ok).toBe(true);
  });
});
