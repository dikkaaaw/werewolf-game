/**
 * Room role-configuration validation.
 *
 * One module, fully testable, run before every game start. Everything the
 * engine would later assume (role count sums to player count, a werewolf
 * exists, both sides can win) is proved here rather than discovered mid-game.
 */
import { getRole, isRegisteredRole, listRoleKeys } from './role-registry';
import { SETTINGS } from './settings';
import type { RoleConfigEntry } from './types';

export interface ValidationIssue {
  /** Dotted path into the submitted config, for field-level UI errors. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: RoleConfigEntry[]; warnings: string[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validate a proposed role configuration.
 *
 * `config` is normalised on success: entries with `roleCount === 0` are
 * dropped, duplicate role keys are summed, and each `config` object is
 * replaced by the parsed result of the role's schema (so defaults land in the
 * database rather than being re-derived at resolution time).
 */
export function validateRoleConfig(
  input: readonly RoleConfigEntry[],
  playerCount: number,
  options: {
    maxPlayersPerRoom?: number;
    minStartablePlayers?: number;
  } = {},
): ValidationResult {
  const maxPlayers = options.maxPlayersPerRoom ?? SETTINGS.roster.maxPlayersPerRoom;
  const minStartable = options.minStartablePlayers ?? SETTINGS.gameplay.minStartablePlayers;
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];

  // --- 1. Player count sanity -------------------------------------------------
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    issues.push({ path: 'playerCount', message: 'Player count must be a positive integer.' });
  } else {
    if (playerCount < minStartable) {
      issues.push({
        path: 'playerCount',
        message: `Need at least ${minStartable} players to start (got ${playerCount}).`,
      });
    }
    if (playerCount > maxPlayers) {
      issues.push({
        path: 'playerCount',
        message: `Room capacity is ${maxPlayers} players (got ${playerCount}).`,
      });
    }
    if (playerCount < 3) {
      issues.push({
        path: 'playerCount',
        message: 'A game needs at least 3 players for the win conditions to be meaningful.',
      });
    }
  }

  // --- 2. Shape of each entry -------------------------------------------------
  const merged = new Map<string, { roleCount: number; configs: Record<string, unknown>[] }>();

  for (const [index, entry] of input.entries()) {
    const path = `roles[${index}]`;

    if (!entry || typeof entry !== 'object') {
      issues.push({ path, message: 'Each role entry must be an object.' });
      continue;
    }

    // 2a. Registered in the engine? An unsupported role must never be startable.
    if (!isRegisteredRole(entry.roleKey)) {
      issues.push({
        path: `${path}.roleKey`,
        message: `Unknown role "${String(entry.roleKey)}". Supported roles: ${listRoleKeys().join(', ')}.`,
      });
      continue;
    }

    // 2b. Non-negative integer count.
    if (!Number.isInteger(entry.roleCount) || entry.roleCount < 0) {
      issues.push({
        path: `${path}.roleCount`,
        message: `Role count for "${entry.roleKey}" must be a non-negative integer.`,
      });
      continue;
    }

    const existing = merged.get(entry.roleKey);
    const config = entry.config ?? {};
    if (existing) {
      // Duplicate keys are summed rather than silently overwriting each other.
      existing.roleCount += entry.roleCount;
      existing.configs.push(config);
    } else {
      merged.set(entry.roleKey, { roleCount: entry.roleCount, configs: [config] });
    }
  }

  // --- 3. Per-role config schema --------------------------------------------
  const normalised: RoleConfigEntry[] = [];

  for (const [roleKey, { roleCount, configs }] of merged) {
    const role = getRole(roleKey)!;

    if (configs.length > 1) {
      warnings.push(`"${roleKey}" appeared ${configs.length} times; counts were summed.`);
    }

    // Merged duplicates must not disagree on config.
    const [first, ...rest] = configs;
    for (const other of rest) {
      if (JSON.stringify(first) !== JSON.stringify(other)) {
        issues.push({
          path: `roles.${roleKey}.config`,
          message: `Conflicting configuration supplied for duplicate role "${roleKey}".`,
        });
      }
    }

    const parsed = role.configSchema.safeParse(first ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          path: `roles.${roleKey}.config.${issue.path.join('.')}`,
          message: issue.message,
        });
      }
      continue;
    }

    if (roleCount > 0) {
      normalised.push({ roleKey, roleCount, config: parsed.data });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // --- 4. Totals ---------------------------------------------------------------
  const totalRoles = normalised.reduce((sum, entry) => sum + entry.roleCount, 0);

  if (totalRoles !== playerCount) {
    issues.push({
      path: 'roles',
      message: `Role counts total ${totalRoles} but there are ${playerCount} players. They must match exactly.`,
    });
  }

  // --- 5. Composition must allow BOTH sides to win ----------------------------
  const werewolfCount = normalised.find((entry) => entry.roleKey === 'werewolf')?.roleCount ?? 0;
  const villageCount = totalRoles - werewolfCount;

  if (totalRoles > 0 && werewolfCount === 0) {
    issues.push({
      path: 'roles',
      message: 'At least one Werewolf is required, otherwise the werewolf side can never win.',
    });
  }

  if (werewolfCount > 0 && villageCount === 0) {
    issues.push({
      path: 'roles',
      message: 'At least one non-werewolf is required, otherwise the village side can never win.',
    });
  }

  // A single werewolf against one villager is a coin-flip game, not a broken
  // one, so it is allowed — but the host should know.
  if (werewolfCount > 0 && werewolfCount * 2 >= totalRoles && totalRoles >= 4) {
    warnings.push(
      `Werewolves are ${werewolfCount} of ${totalRoles} players — the village starts at or below parity.`,
    );
  }

  // The parity warning above cannot see the 5-player floor case: one Werewolf
  // among five is 2 >= 5, i.e. false, so it stays silent. But that is exactly
  // the hardest setup in the game — with `aliveWerewolves >=
  // aliveNonWerewolves` as the wolf win condition, a lone wolf must survive
  // until parity, and a single successful village vote ends the game on the
  // spot. Warn without blocking: it is a legitimate choice, not an error.
  if (
    werewolfCount === 1 &&
    totalRoles > 0 &&
    totalRoles <= SETTINGS.gameplay.minStartablePlayers
  ) {
    warnings.push(
      `A single Werewolf against ${villageCount} village players has to survive to parity to win — ` +
        'one correct vote ends the game immediately. Consider a second Werewolf.',
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, config: normalised, warnings };
}
