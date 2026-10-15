import { describe, expect, it } from 'vitest';

import { listRoleKeys } from '@/lib/game/role-registry';
import {
  ROLE_ARTWORK_DIR,
  ROLE_ARTWORK_DIR_ALT,
  ROLE_CHARACTER_IMAGE,
  getRoleCharacterArtwork,
  hasRoleArtwork,
  type RoleArtworkKey,
} from '@/lib/game/role-artwork';

describe('Role artwork — mapping', () => {
  it('maps every role the engine actually supports', () => {
    // This is the load-bearing assertion: if a role is added to the registry,
    // the artwork mapping must be updated in the same change.
    const engineRoles = listRoleKeys().sort();
    const artworkRoles = Object.keys(ROLE_CHARACTER_IMAGE).sort();

    expect(artworkRoles).toEqual(engineRoles);
  });

  it('resolves a distinct file for each supported role', () => {
    const werewolf = getRoleCharacterArtwork('werewolf');
    const villager = getRoleCharacterArtwork('villager');
    const seer = getRoleCharacterArtwork('seer');
    const doctor = getRoleCharacterArtwork('guardian_angel');

    expect(new Set([werewolf, villager, seer, doctor]).size).toBe(4);
    expect(werewolf).toBe('/assets/images/role-character/werewolf.jpg');
    expect(villager).toBe('/assets/images/role-character/villager.jpg');
    expect(seer).toBe('/assets/images/role-character/seer.jpg');
    // The Doctor plays the protective archetype, which is guardian_angel.jpg.
    expect(doctor).toBe('/assets/images/role-character/guardian_angel.jpg');
  });

  it('serves every path from the local public directory', () => {
    for (const path of Object.values(ROLE_CHARACTER_IMAGE)) {
      expect(path.startsWith('/assets/images/')).toBe(true);
      expect(path.endsWith('.jpg')).toBe(true);
      expect(path).not.toContain('//');
    }
  });

  it('exposes both directory spellings for the on-disk symlink', () => {
    expect(ROLE_ARTWORK_DIR).toBe('/assets/images/role-character');
    expect(ROLE_ARTWORK_DIR_ALT).toBe('/assets/images/role_character');
  });
});

describe('Role artwork — fallback behaviour', () => {
  it('returns null for unknown roles so the SVG emblem can take over', () => {
    expect(getRoleCharacterArtwork('wizard')).toBeNull();
    expect(getRoleCharacterArtwork('doctor ')).toBeNull();
    expect(getRoleCharacterArtwork('')).toBeNull();
  });

  it('returns null for missing roles rather than throwing', () => {
    expect(getRoleCharacterArtwork(null)).toBeNull();
    expect(getRoleCharacterArtwork(undefined)).toBeNull();
  });

  it('normalizes case so a stray uppercase key still resolves', () => {
    expect(getRoleCharacterArtwork('WEREWOLF')).toBe(ROLE_CHARACTER_IMAGE.werewolf);
    expect(getRoleCharacterArtwork('Werewolf')).toBe(ROLE_CHARACTER_IMAGE.werewolf);
    expect(hasRoleArtwork('SEER')).toBe(true);
  });

  it('reports artwork availability consistently', () => {
    for (const key of Object.keys(ROLE_CHARACTER_IMAGE) as RoleArtworkKey[]) {
      expect(hasRoleArtwork(key)).toBe(true);
    }
    expect(hasRoleArtwork('unknown-role')).toBe(false);
    expect(hasRoleArtwork(null)).toBe(false);
  });

  it('does not map roles the engine does not implement', () => {
    // `set_role_config` only accepts werewolf/villager/seer/doctor, so mapping
    // the extra artwork files would imply roles the game cannot deal.
    const mapped = new Set(Object.keys(ROLE_CHARACTER_IMAGE));
    expect(mapped.has('hunter')).toBe(true);
    expect(mapped.has('sorcerer')).toBe(false);
    expect(mapped.has('serial_killer')).toBe(false);
  });
});