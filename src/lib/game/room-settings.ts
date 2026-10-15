/**
 * Room game settings: phase durations + role composition.
 *
 * Pure and dependency-free so the same rules can run in the browser (instant
 * host feedback) and on the server (authoritative rejection) without a second
 * copy drifting between them. The database is still the final gate — see
 * `set_role_config` and `set_room_settings` — this module is the shared
 * pre-flight, not the authority.
 *
 * Persistence model (no new tables):
 *   - Phase durations live in `rooms.settings.phaseSeconds` (jsonb).
 *   - Role composition lives in `room_role_configs`, written by the existing
 *     `set_role_config` RPC. Nothing here writes to the database.
 */
import { SETTINGS } from './settings';
import type { PhaseDurationOverrides } from './phase-manager';
import type { RoleConfigEntry } from './types';

export const PHASE_KEYS = ['night', 'day', 'voting'] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

/** All three durations always resolved — never partial at the point of use. */
export type PhaseSeconds = Record<PhaseKey, number>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** The built-in defaults, used for a room with no `settings.phaseSeconds`. */
export function defaultPhaseSeconds(): PhaseSeconds {
  return {
    night: SETTINGS.phaseSeconds.night,
    day: SETTINGS.phaseSeconds.day,
    voting: SETTINGS.phaseSeconds.voting,
  };
}

/** The bounds for one phase, read from SETTINGS so UI and server cannot drift. */
export function phaseSecondsBoundsFor(phase: PhaseKey): { min: number; max: number } {
  return SETTINGS.phaseSecondsBounds[phase];
}

/**
 * Is one duration a valid setting for its phase?
 *
 * Must be an integer inside the per-phase bounds. The bounds are the same ones
 * `phaseDurationSeconds` clamps to, so a value accepted here can never be
 * silently clamped later into something the host did not choose.
 */
export function isValidPhaseSeconds(phase: PhaseKey, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  const { min, max } = phaseSecondsBoundsFor(phase);
  return value >= min && value <= max;
}

export type PhaseSecondsValidation =
  | { ok: true; phaseSeconds: PhaseSeconds }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validate a partial phase-duration payload and resolve it to a complete set.
 *
 * Absent phases fall back to the built-in default rather than being rejected,
 * so the host can adjust one duration without restating the other two. A
 * present-but-invalid value is an error, never a silent fallback — that is what
 * stops a typo from producing a one-second night.
 */
export function validatePhaseSeconds(
  input: unknown,
): PhaseSecondsValidation {
  const issues: ValidationIssue[] = [];

  if (input === undefined || input === null) {
    return { ok: true, phaseSeconds: defaultPhaseSeconds() };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: 'phaseSeconds', message: 'Phase durations must be an object.' }],
    };
  }

  const record = input as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter((key) => !PHASE_KEYS.includes(key as PhaseKey));
  if (extraKeys.length > 0) {
    issues.push({
      path: 'phaseSeconds',
      message: `Unknown phase "${extraKeys[0]}". Supported: ${PHASE_KEYS.join(', ')}.`,
    });
  }

  const resolved = defaultPhaseSeconds();

  for (const phase of PHASE_KEYS) {
    const raw = record[phase];
    if (raw === undefined) continue;
    if (!isValidPhaseSeconds(phase, raw)) {
      const { min, max } = phaseSecondsBoundsFor(phase);
      issues.push({
        path: `phaseSeconds.${phase}`,
        message: `${phase} duration must be a whole number of seconds between ${min} and ${max}.`,
      });
      continue;
    }
    resolved[phase] = raw;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, phaseSeconds: resolved };
}

/**
 * Read `rooms.settings.phaseSeconds` defensively.
 *
 * A missing or malformed value falls back to the defaults rather than throwing:
 * this runs on a hot read path, and a corrupt settings row must not take the
 * room offline. Values are clamped into range for the same reason
 * `phaseDurationSeconds` clamps — a bad row cannot produce an absurd deadline.
 */
export function phaseSecondsFromRoomSettings(settings: unknown): PhaseSeconds {
  const resolved = defaultPhaseSeconds();
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return resolved;

  const raw = (settings as Record<string, unknown>).phaseSeconds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return resolved;

  const record = raw as Record<string, unknown>;
  for (const phase of PHASE_KEYS) {
    const value = record[phase];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = phaseSecondsBoundsFor(phase);
    resolved[phase] = Math.min(max, Math.max(min, Math.floor(value)));
  }
  return resolved;
}

/** Adapt a resolved set to the shape `phase-manager` accepts as overrides. */
export function toPhaseDurationOverrides(phaseSeconds: PhaseSeconds): PhaseDurationOverrides {
  return { night: phaseSeconds.night, day: phaseSeconds.day, voting: phaseSeconds.voting };
}

// --- Role composition ---------------------------------------------------------

export type RoleCounts = Record<string, number>;

/**
 * Reduce validated role entries to `{ roleKey: roleCount }`, summing duplicates.
 * Entries with a zero count are omitted so the shape matches what
 * `set_role_config` persists (it skips zero rows).
 */
export function roleCountsFromEntries(entries: readonly RoleConfigEntry[]): RoleCounts {
  const counts: RoleCounts = {};
  for (const entry of entries) {
    if (!entry || typeof entry.roleKey !== 'string') continue;
    const count = Number(entry.roleCount);
    if (!Number.isInteger(count) || count <= 0) continue;
    counts[entry.roleKey] = (counts[entry.roleKey] ?? 0) + count;
  }
  return counts;
}

export interface RoleCompositionInput {
  werewolf: number;
  seer: number;
  guardian_angel: number;
  hunter?: number;
  tanner?: number;
  mayor?: number;
  villager: number;
}

/** Turn the editable counts into the entry shape the validator expects. */
export function roleEntriesFromCounts(counts: RoleCompositionInput): RoleConfigEntry[] {
  return [
    { roleKey: 'werewolf', roleCount: counts.werewolf, config: {} },
    { roleKey: 'seer', roleCount: counts.seer, config: {} },
    { roleKey: 'guardian_angel', roleCount: counts.guardian_angel, config: {} },
    { roleKey: 'hunter', roleCount: counts.hunter ?? 0, config: {} },
    { roleKey: 'tanner', roleCount: counts.tanner ?? 0, config: {} },
    { roleKey: 'mayor', roleCount: counts.mayor ?? 0, config: {} },
    { roleKey: 'villager', roleCount: counts.villager, config: {} },
  ];
}

/**
 * Which roles are directly host-editable.
 *
 * Kept as an explicit list rather than derived from the registry so the lobby
 * UI and the settings payload agree on exactly the supported knobs. A role added
 * to the registry later still validates through `validateRoleConfig`; it simply
 * is not surfaced as a spinner until it is added here.
 */
export const EDITABLE_ROLE_KEYS = [
  'werewolf',
  'seer',
  'guardian_angel',
  'hunter',
  'tanner',
  'mayor',
  'villager',
] as const;
export type EditableRoleKey = (typeof EDITABLE_ROLE_KEYS)[number];

/**
 * Read a saved composition out of `room_role_configs` rows (or the snapshot
 * projection of them) into the editable numbers, defaulting to the
 * balanced distribution for the current player count when absent.
 */
export function compositionFromCounts(
  raw: Record<string, number> | undefined,
  playerCount: number,
  fallback: readonly RoleConfigEntry[],
): Record<EditableRoleKey, number> {
  const resolved: Record<EditableRoleKey, number> = {
    werewolf: 0,
    seer: 0,
    guardian_angel: 0,
    hunter: 0,
    tanner: 0,
    mayor: 0,
    villager: 0,
  };

  if (raw) {
    for (const key of EDITABLE_ROLE_KEYS) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        resolved[key] = value;
      }
    }
  }

  const total = EDITABLE_ROLE_KEYS.reduce((sum, key) => sum + resolved[key], 0);
  if (total === playerCount) return resolved;

  // No saved config, or a config left stale by a join/leave: fall back to the
  // balanced default so the host always sees numbers that actually add up.
  const fallbackCounts = roleCountsFromEntries(fallback);
  for (const key of EDITABLE_ROLE_KEYS) {
    resolved[key] = fallbackCounts[key] ?? 0;
  }
  return resolved;
}
