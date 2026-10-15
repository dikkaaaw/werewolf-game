/**
 * Role registry — the single extension point for the game.
 *
 * To add a role:
 *   1. Add a `RoleDefinition` below.
 *   2. If it has a night action, add the action type to NIGHT_ACTION_TYPES
 *      (src/lib/game/types.ts) and handle its effect class in night-resolution.ts.
 *   3. If it needs a new alignment or a new win rule, extend win-condition.ts.
 *
 * No API handler, migration, or UI change is required. Anything not in this
 * registry is rejected by validateRoleConfig, so an unsupported role can never
 * be configured into a live game.
 */
import { z } from 'zod'

import type { RoleDefinition } from './types'

/** Roles with no night action still need an (empty) config schema. */
const emptyConfigSchema = z.object({}).strict()

const werewolf: RoleDefinition = {
    roleKey: 'werewolf',
    displayName: 'Werewolf',
    description:
        'Each night the werewolves choose one player to eliminate. They win when they equal or outnumber the remaining village.',
    alignment: 'werewolf',
    nightAction: 'eliminate',
    actionPriority: 100,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        // A1: a Werewolf may not eliminate another Werewolf. The reference
        // implementation enforces the same thing (Werewolf.cs:5187 and :1051 filter
        // the kill menu to `!WolfRoles.Contains(...)`), and the approved product
        // decision makes it a server-side rule rather than a UI convenience.
        canTargetSameRole: false,
    },
    countsForWinAs: 'werewolf',
    /**
     * No per-room configuration.
     *
     * `requireUnanimous` used to live here. It declared that the whole werewolf
     * team must agree on one target, but NOTHING ever read it — `resolveNight`
     * always resolves the kill by plurality with a lowest-seat tie-break, and no
     * server code consulted `room_role_configs.config`. So it was an accepted,
     * persisted, silently-ignored option: a host could switch it on and the game
     * would behave exactly the same. Removed rather than left to mislead.
     *
     * Plurality with a stable lowest-seat tie-break IS the rule; it is documented
     * in GAME-RULES.md §6 and covered by night-resolution tests. Changing it is a
     * product decision, not a config value.
     */
    configSchema: emptyConfigSchema,
}

const villager: RoleDefinition = {
    roleKey: 'villager',
    displayName: 'Villager',
    description:
        'No special night action. Wins by helping the village identify every werewolf. Discuss and vote during the day.',
    alignment: 'village',
    nightAction: null,
    actionPriority: null,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        // No night action, so this is inert, but kept so every role's TargetRules
        // satisfies the same shape.
        canTargetSameRole: true,
    },
    countsForWinAs: 'village',
    configSchema: emptyConfigSchema,
}

const seer: RoleDefinition = {
    roleKey: 'seer',
    displayName: 'Seer',
    description:
        'Each night, inspect one player to learn their alignment. The result is visible only to you, never announced.',
    alignment: 'village',
    nightAction: 'investigate',
    actionPriority: 300,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        // A Seer may inspect another Seer. Nothing restricts same-role inspection,
        // and unlike the reference (whose Seer reveals the exact role) this project's
        // Seer only ever reports ALIGNMENT — see the `reveal` removal below.
        canTargetSameRole: true,
    },
    countsForWinAs: 'village',
    /**
     * No per-room configuration.
     *
     * `reveal: 'role' | 'alignment'` used to live here. It was accepted and
     * persisted, but `resolveNight` has only ever produced an alignment result and
     * no server code read this field — so `'role'` was silently ignored and a host
     * could not get exact-role readings. Removed rather than left to mislead.
     *
     * The Seer reports the target's ALIGNMENT, privately. That is the rule; see
     * GAME-RULES.md §2 and the night-resolution tests.
     */
    configSchema: emptyConfigSchema,
}

const guardianAngel: RoleDefinition = {
    roleKey: 'guardian_angel',
    displayName: 'Guardian Angel',
    description:
        'Each night, protect one player. A protected player survives that night’s elimination.',
    alignment: 'village',
    nightAction: 'protect',
    actionPriority: 200,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: true,
        // A2: a Doctor may not protect another Doctor. Not implied by the default
        // configuration (one Doctor) — a host may configure several — so this is a
        // rule, enforced from `player_secrets` on both sides.
        canTargetSameRole: false,
    },
    countsForWinAs: 'village',
    /**
     * The MVP Doctor has no per-room configuration.
     *
     * `allowSelfProtect` used to live here. It defaulted to `false` and was read
     * by `validateNightAction`, but the authoritative `submit_night_action` RPC
     * rejected self-targets unconditionally — so the setting could never take
     * effect and only implied a capability the game does not have. Removed
     * rather than left as a misleading no-op.
     *
     * Self-protection is a new rule, not a config value: it needs a PRD decision
     * and an RPC change together, or the two drift apart again.
     *
     * Multi-protect is likewise not configurable — the unique key on
     * `game_actions` already caps a doctor at one protect per round.
     */
    configSchema: emptyConfigSchema,
}



const lycan: RoleDefinition = {
    roleKey: 'lycan',
    displayName: 'Lycan',
    description:
        'A wolf-team member with no night action. To the Seer, the Lycan nevertheless reads as a Villager.',
    alignment: 'werewolf',
    nightAction: null,
    actionPriority: null,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        canTargetSameRole: true,
    },
    countsForWinAs: 'werewolf',
    configSchema: emptyConfigSchema,
}

const hunter: RoleDefinition = {
    roleKey: 'hunter',
    displayName: 'Hunter',
    description:
        'No night action. Upon death, the Hunter may choose an alive player to eliminate.',
    alignment: 'village',
    nightAction: null,
    actionPriority: null,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: true,
        forbidRepeatTarget: false,
        canTargetSameRole: true,
    },
    countsForWinAs: 'village',
    configSchema: emptyConfigSchema,
}

const tanner: RoleDefinition = {
    roleKey: 'tanner',
    displayName: 'Tanner',
    description:
        'Hates life and wants to die. If the Tanner is lynched during the day, the Tanner wins the game alone.',
    alignment: 'neutral',
    nightAction: null,
    actionPriority: null,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        canTargetSameRole: true,
    },
    countsForWinAs: 'neutral',
    configSchema: emptyConfigSchema,
}

const mayor: RoleDefinition = {
    roleKey: 'mayor',
    displayName: 'Mayor',
    description:
        'A powerful village leader. Once the Mayor reveals themselves, their vote counts as two votes in every lynching.',
    alignment: 'village',
    nightAction: null,
    actionPriority: null,
    targetRules: {
        canTargetSelf: false,
        canTargetDead: false,
        forbidRepeatTarget: false,
        canTargetSameRole: true,
    },
    countsForWinAs: 'village',
    configSchema: emptyConfigSchema,
}

const ROLES: readonly RoleDefinition[] = [werewolf, villager, seer, guardianAngel, lycan, hunter, tanner, mayor]

const ROLE_MAP: ReadonlyMap<string, RoleDefinition> = new Map(
    ROLES.map((role) => [role.roleKey, role])
)

export function getRole(roleKey: string): RoleDefinition | undefined {
    return ROLE_MAP.get(canonicalRoleKey(roleKey))
}

/** Throws if the role is unknown — use where the role is already known-valid. */
export function requireRole(roleKey: string): RoleDefinition {
    const role = ROLE_MAP.get(canonicalRoleKey(roleKey))
    if (!role) {
        throw new Error(`Unknown role key: ${roleKey}`)
    }
    return role
}


const ROLE_ALIASES: Record<string, string> = {
    // Compatibility: saved role configurations created before the Doctor ->
    // Guardian Angel replacement may still carry `doctor`. Treat it as the
    // current role rather than rejecting the persisted row outright.
    doctor: 'guardian_angel',
};

/** Normalise a legacy role key to the current active role key. */
export function canonicalRoleKey(roleKey: string): string {
    return ROLE_ALIASES[roleKey] ?? roleKey;
}

export function isRegisteredRole(roleKey: string): boolean {
    return ROLE_MAP.has(canonicalRoleKey(roleKey)) || Object.prototype.hasOwnProperty.call(ROLE_ALIASES, roleKey)
}

export function listRoles(): readonly RoleDefinition[] {
    return ROLES
}

export function listRoleKeys(): string[] {
    return ROLES.map((role) => role.roleKey)
}

/** True when the role may submit `actionType` at night. */
export function roleSupportsAction(roleKey: string, actionType: string): boolean {
    const role = ROLE_MAP.get(canonicalRoleKey(roleKey))
    return Boolean(role && role.nightAction === actionType)
}
