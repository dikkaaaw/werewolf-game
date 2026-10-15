import { describe, expect, it } from 'vitest';
import { getRole, requireRole, isRegisteredRole } from '@/lib/game/role-registry';
import { getRoleCharacterArtwork, hasRoleArtwork } from '@/lib/game/role-artwork';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { EDITABLE_ROLE_KEYS } from '@/lib/game/room-settings';

describe('Mayor role specification and registry', () => {
  it('is registered with village alignment and no night action', () => {
    expect(isRegisteredRole('mayor')).toBe(true);
    const role = requireRole('mayor');
    expect(role.roleKey).toBe('mayor');
    expect(role.displayName).toBe('Mayor');
    expect(role.alignment).toBe('village');
    expect(role.nightAction).toBeNull();
    expect(role.actionPriority).toBeNull();
    expect(role.countsForWinAs).toBe('village');
  });

  it('has character artwork mapped correctly', () => {
    expect(hasRoleArtwork('mayor')).toBe(true);
    expect(getRoleCharacterArtwork('mayor')).toBe('/assets/images/role-character/mayor.jpg');
  });

  it('is included in EDITABLE_ROLE_KEYS for lobby settings', () => {
    expect(EDITABLE_ROLE_KEYS).toContain('mayor');
  });

  it('validates as an acceptable role configuration', () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
      { roleKey: 'mayor', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 1, config: {} },
    ];
    const result = validateRoleConfig(config, 5);
    expect(result.ok).toBe(true);
  });
});
