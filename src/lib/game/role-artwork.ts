/**
 * Role character artwork.
 *
 * Pure mapping module: role key -> local public asset path. No React, no DOM,
 * so it is unit-testable in the Node-based Vitest environment.
 *
 * Privacy: this module is imported only by the Secret Role Card, which mounts
 * the artwork strictly after the authorized reveal stage. Artwork paths are
 * never included in the public room snapshot or any Realtime payload.
 *
 * The files live on disk at `public/assets/images/role-character/` (hyphenated).
 * `public/assets/images/role_character` is a symlink to the same directory so
 * the underscored spelling resolves too.
 */

/** Directory the artwork is served from. */
export const ROLE_ARTWORK_DIR = '/assets/images/role-character';

/** Alternate spelling, kept in step with the on-disk symlink. */
export const ROLE_ARTWORK_DIR_ALT = '/assets/images/role_character';

/**
 * Role keys that have artwork. Kept as a literal union so adding a role to the
 * registry without artwork is a compile error, not a silent fallback.
 */
export type RoleArtworkKey = 'werewolf' | 'villager' | 'seer' | 'guardian_angel' | 'lycan' | 'hunter' | 'tanner' | 'mayor';

/**
 * Artwork file for each in-engine role.
 *
 * `doctor` maps to `guardian_angel.jpg` — the protective archetype the Doctor
 * plays. Every source file is a 3:4 portrait JPEG (750x1050 or 1792x2400).
 */
export const ROLE_CHARACTER_IMAGE: Readonly<Record<RoleArtworkKey, string>> = {
  werewolf: `${ROLE_ARTWORK_DIR}/werewolf.jpg`,
  villager: `${ROLE_ARTWORK_DIR}/villager.jpg`,
  seer: `${ROLE_ARTWORK_DIR}/seer.jpg`,
  guardian_angel: `${ROLE_ARTWORK_DIR}/guardian_angel.jpg`,
  lycan: `${ROLE_ARTWORK_DIR}/lycan.jpg`,
  hunter: `${ROLE_ARTWORK_DIR}/hunter.jpg`,
  tanner: `${ROLE_ARTWORK_DIR}/tanner.jpg`,
  mayor: `${ROLE_ARTWORK_DIR}/mayor.jpg`,
};

/**
 * Every artwork file present in the directory, including archetypes for roles
 * the engine does not implement yet. Listed for visibility only — mapping them
 * would imply roles the registry and `set_role_config` reject.
 */
export const ROLE_ARTWORK_FILES_NOT_IN_ENGINE: readonly string[] = [
  'alpha_wolf',
  'arsonist',
  'beholder',
  'cultist',
  'cultist_hunter',
  'cupid',
  'cursed',
  'detective',
  'doppleganger',
  'drunkman',
  'fool',
  'guardian_angel_is_doctor',
  'harlot',
  'lycan',
  'mason',
  'oracle',
  'prince',
  'serial_killer',
  'sorcerer',
  'thief',
  'troublemaker',
  'wolf_cub',
  'wolfman',
];

/** True when a role key has dedicated character artwork. */
export function hasRoleArtwork(roleKey: string | null | undefined): boolean {
  return getRoleCharacterArtwork(roleKey) !== null;
}

/**
 * Resolve the artwork path for a role key.
 *
 * Returns null for unknown or missing roles so callers can fall back to the
 * inline SVG emblem instead of rendering a broken image.
 */
export function getRoleCharacterArtwork(roleKey: string | null | undefined): string | null {
  if (!roleKey) return null;
  const key = roleKey.toLowerCase() as RoleArtworkKey;
  return ROLE_CHARACTER_IMAGE[key] ?? null;
}