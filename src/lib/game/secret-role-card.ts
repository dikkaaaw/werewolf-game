/**
 * Pure state + presentation model for the secret role card.
 *
 * Deliberately free of React and DOM APIs so the reveal/hide rules can be
 * unit tested in the existing Node-based Vitest environment, and so the card
 * component stays purely presentational.
 */

/**
 * Cinematic reveal timeline.
 *
 *   idle ──role assigned──▶ concealed ──▶ revealing ──▶ settling ──▶ revealed
 *                             (scrim +     (3D flip)   (role parts  (stable)
 *                              card back)                 stagger)
 *
 *   hidden ──open──▶ unfolding ──▶ revealed
 *                  (short fade; never replays the concealed/flip beats)
 */
export interface SecretRoleInvestigation {
    roundNumber: number
    result: { targetPlayerId: string; alignment: string }
}

export interface SecretRoleAssignment {
    roleKey: string
    alignment: string
    investigations?: SecretRoleInvestigation[]
}

export interface SecretRoleCardState {
    /** Scope the cached secret belongs to. Any change drops the cached role. */
    scope: string | null
    roleKey: string | null
    alignment: string | null
    investigations: SecretRoleInvestigation[]
}

export type SecretRoleCardAction =
    | { type: 'role-assigned'; scope: string; role: SecretRoleAssignment }
    | { type: 'access-lost'; scope: string | null }
    | { type: 'open' }
    | { type: 'close' }
    | { type: 'close-finished' }
    | { type: 'reveal-started' }
    | { type: 'reveal-finished' }
    | { type: 'settle-finished' }
    | { type: 'unfold-finished' }

export const initialSecretRoleCardState: SecretRoleCardState = {
    scope: null,
    roleKey: null,
    alignment: null,
    investigations: [],
}

export function secretRoleScope(roomId: string, roomCreatedAt?: string | null): string {
    return `${roomId}@${roomCreatedAt ?? 'unknown'}`
}

function sameInvestigations(
    a: readonly SecretRoleInvestigation[],
    b: readonly SecretRoleInvestigation[]
): boolean {
    if (a.length !== b.length) return false
    return a.every(
        (item, index) =>
            item.roundNumber === b[index].roundNumber &&
            item.result?.targetPlayerId === b[index].result?.targetPlayerId &&
            item.result?.alignment === b[index].result?.alignment
    )
}

export function secretRoleCardReducer(
    state: SecretRoleCardState,
    action: SecretRoleCardAction
): SecretRoleCardState {
    switch (action.type) {
        case 'role-assigned': {
            if (state.scope !== action.scope) {
                return {
                    scope: action.scope,
                    roleKey: action.role.roleKey,
                    alignment: action.role.alignment,
                    investigations: action.role.investigations ?? [],
                }
            }
            // Refresh private intel (e.g. new Seer results). Returning the identical
            // object when nothing changed keeps Realtime bursts from re-rendering
            // the card at all.
            const investigations = action.role.investigations ?? []
            const unchanged =
                state.roleKey === action.role.roleKey &&
                state.alignment === action.role.alignment &&
                sameInvestigations(state.investigations, investigations)
            if (unchanged) return state

            return {
                ...state,
                roleKey: action.role.roleKey,
                alignment: action.role.alignment,
                investigations,
            }
        }

        case 'access-lost': {
            if (action.scope !== null && state.scope !== action.scope) return state
            return initialSecretRoleCardState
        }

        default:
            return state
    }
}

export function hasSecretRole(state: SecretRoleCardState): boolean {
    return state.roleKey !== null
}

/**
 * Guards rendering against a stale secret: any cached role must belong to the
 * scope currently being displayed.
 */
export function isSecretRoleCurrent(state: SecretRoleCardState, scope: string | null): boolean {
    return state.scope === scope && hasSecretRole(state)
}

/**
 * Presentation for the secret role card, split in two on purpose.
 *
 * Identity (title, description, emblem) is fixed per role: that is the
 * information the player is entitled to see.
 *
 * Colour is NOT tied to the role. A fixed palette makes the card a fingerprint:
 * anyone glancing over a shoulder learns "red means werewolf", and that mapping
 * survives every later session. The palette is therefore shuffled into a fresh
 * role-to-colour assignment each time the module is loaded, and held for the
 * rest of that page load so the card never flickers mid-game.
 *
 * With four roles drawn from this pool, a given role lands on a different colour
 * each session, so no colour means anything on its own.
 */

export type SecretRoleEmblem = 'werewolf' | 'seer' | 'doctor' | 'villager'

export interface SecretRoleIdentity {
    title: string
    description: string
    emblem: SecretRoleEmblem
}

export interface SecretRolePalette {
    accentText: string
    accentGlow: string
    accentSoftBg: string
    accentBorder: string
    /** Ambient bloom painted behind the card while it is the focus. */
    auraBg: string
    /** Colour for the ornamental card back motif. */
    backMotif: string
    /** Colour for the revealed faction badge. */
    factionBadge: string
}

export interface SecretRolePresentation extends SecretRoleIdentity, SecretRolePalette {}

/**
 * Colour treatments the card can wear. Deliberately larger than the role count
 * so the assignment is not a 1:1 guess.
 */
export const ROLE_COLOR_PALETTES: readonly SecretRolePalette[] = [
    {
        accentText: 'text-rose-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(244,63,94,0.7)]',
        accentSoftBg: 'from-rose-950/80',
        accentBorder: 'border-rose-500/50',
        auraBg: 'bg-rose-600/15',
        backMotif: 'text-rose-300/70',
        factionBadge: 'border-rose-500/60 bg-rose-950/60 text-rose-200',
    },
    {
        accentText: 'text-violet-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(167,139,250,0.7)]',
        accentSoftBg: 'from-violet-950/80',
        accentBorder: 'border-violet-500/50',
        auraBg: 'bg-violet-600/15',
        backMotif: 'text-violet-300/70',
        factionBadge: 'border-violet-500/60 bg-violet-950/60 text-violet-200',
    },
    {
        accentText: 'text-teal-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(45,212,191,0.65)]',
        accentSoftBg: 'from-teal-950/80',
        accentBorder: 'border-teal-500/50',
        auraBg: 'bg-teal-600/15',
        backMotif: 'text-teal-300/70',
        factionBadge: 'border-teal-500/60 bg-teal-950/60 text-teal-200',
    },
    {
        accentText: 'text-amber-200',
        accentGlow: 'shadow-[0_0_50px_-14px_rgba(251,191,36,0.55)]',
        accentSoftBg: 'from-amber-950/60',
        accentBorder: 'border-amber-500/40',
        auraBg: 'bg-amber-500/12',
        backMotif: 'text-amber-300/70',
        factionBadge: 'border-amber-500/50 bg-amber-950/50 text-amber-200',
    },
    {
        accentText: 'text-emerald-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(16,185,129,0.7)]',
        accentSoftBg: 'from-emerald-950/80',
        accentBorder: 'border-emerald-500/50',
        auraBg: 'bg-emerald-600/15',
        backMotif: 'text-emerald-300/70',
        factionBadge: 'border-emerald-500/60 bg-emerald-950/60 text-emerald-200',
    },
    {
        accentText: 'text-sky-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(14,165,233,0.7)]',
        accentSoftBg: 'from-sky-950/80',
        accentBorder: 'border-sky-500/50',
        auraBg: 'bg-sky-600/15',
        backMotif: 'text-sky-300/70',
        factionBadge: 'border-sky-500/60 bg-sky-950/60 text-sky-200',
    },
    {
        accentText: 'text-orange-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(249,115,22,0.7)]',
        accentSoftBg: 'from-orange-950/80',
        accentBorder: 'border-orange-500/50',
        auraBg: 'bg-orange-600/15',
        backMotif: 'text-orange-300/70',
        factionBadge: 'border-orange-500/60 bg-orange-950/60 text-orange-200',
    },
    {
        accentText: 'text-fuchsia-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(232,121,249,0.7)]',
        accentSoftBg: 'from-fuchsia-950/80',
        accentBorder: 'border-fuchsia-500/50',
        auraBg: 'bg-fuchsia-600/15',
        backMotif: 'text-fuchsia-300/70',
        factionBadge: 'border-fuchsia-500/60 bg-fuchsia-950/60 text-fuchsia-200',
    },
    {
        accentText: 'text-lime-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(132,204,22,0.7)]',
        accentSoftBg: 'from-lime-950/80',
        accentBorder: 'border-lime-500/50',
        auraBg: 'bg-lime-600/15',
        backMotif: 'text-lime-300/70',
        factionBadge: 'border-lime-500/60 bg-lime-950/60 text-lime-200',
    },
    {
        accentText: 'text-indigo-300',
        accentGlow: 'shadow-[0_0_50px_-10px_rgba(99,102,241,0.7)]',
        accentSoftBg: 'from-indigo-950/80',
        accentBorder: 'border-indigo-500/50',
        auraBg: 'bg-indigo-600/15',
        backMotif: 'text-indigo-300/70',
        factionBadge: 'border-indigo-500/60 bg-indigo-950/60 text-indigo-200',
    },
]

/** Fixed, deliberately colourless treatment for roles we cannot name. */
export const NEUTRAL_PALETTE: SecretRolePalette = {
    accentText: 'text-slate-300',
    accentGlow: 'shadow-[0_0_50px_-14px_rgba(100,116,139,0.5)]',
    accentSoftBg: 'from-slate-950/60',
    accentBorder: 'border-slate-500/50',
    auraBg: 'bg-slate-600/10',
    backMotif: 'text-slate-300/70',
    factionBadge: 'border-slate-500/50 bg-slate-950/50 text-slate-200',
}

/**
 * Role copy. Mirrors the shared role registry so the card never contradicts the
 * rules engine.
 */
export const SECRET_ROLE_IDENTITY: Record<string, SecretRoleIdentity> = {
    werewolf: {
        title: 'Werewolf',
        emblem: 'werewolf',
        description:
            'Each night the pack eliminates one player. Win by matching or outnumbering the remaining village.',
    },
    seer: {
        title: 'Seer',
        emblem: 'seer',
        description:
            'Each night inspect one player to learn their alignment. Your visions are visible only to you.',
    },
    doctor: {
        title: 'Doctor',
        emblem: 'doctor',
        description:
            'Each night protect one player. A protected player survives that night’s elimination.',
    },
    villager: {
        title: 'Villager',
        emblem: 'villager',
        description:
            'No special night action. Win by helping the village identify every werewolf through debate and voting.',
    },
}

/**
 * Deal the pool out across the roles in whatever order `shuffle` returns, so no
 * role has a colour anyone could learn. Exported for tests: the security
 * property here is that two different shuffles produce different assignments.
 */
export function assignSessionPalettes(
    roles: readonly string[],
    shuffle: <T>(items: readonly T[]) => T[],
): Record<string, SecretRolePalette> {
    const pool = shuffle(ROLE_COLOR_PALETTES)
    const assignment: Record<string, SecretRolePalette> = {}
    roles.forEach((role, index) => {
        assignment[role] = pool[index % pool.length]
    })
    return assignment
}

/** Cryptographically random Fisher-Yates; falls back to Math.random. */
function secureShuffle<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i -= 1) {
        const source =
            typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
                ? crypto.getRandomValues(new Uint32Array(1))[0]
                : Math.floor(Math.random() * 0xffffffff)
        const j = source % (i + 1)
        const tmp = out[i]
        out[i] = out[j]
        out[j] = tmp
    }
    return out
}

let sessionPalettes: Record<string, SecretRolePalette> | null = null

/**
 * The role-to-colour assignment for this page load. Built once, on first use,
 * and then reused so re-renders and Realtime updates cannot repaint the card.
 */
function getSessionPalettes(): Record<string, SecretRolePalette> {
    if (!sessionPalettes) {
        // No randomness on the server: static markup stays deterministic.
        const shuffle =
            typeof window === 'undefined'
                ? <T,>(items: readonly T[]) => items.slice()
                : secureShuffle
        sessionPalettes = assignSessionPalettes(Object.keys(SECRET_ROLE_IDENTITY), shuffle)
    }
    return sessionPalettes
}

/** Test hook: forces the next read to deal a fresh assignment. */
export function resetSecretRolePaletteSession(): void {
    sessionPalettes = null
}

export function getSecretRolePresentation(roleKey: string | null): SecretRolePresentation {
    if (!roleKey) return { ...SECRET_ROLE_IDENTITY.villager, ...NEUTRAL_PALETTE }
    const key = roleKey.toLowerCase()
    const identity = SECRET_ROLE_IDENTITY[key]
    if (!identity) return { ...SECRET_ROLE_IDENTITY.villager, ...NEUTRAL_PALETTE }
    const palette = getSessionPalettes()[key] ?? NEUTRAL_PALETTE
    return { ...identity, ...palette }
}

export function getRoleTeamLabel(alignment: string | null): string {
    if (alignment === 'werewolf') return 'Werewolf Pack'
    if (alignment === 'village') return 'Village'
    return 'Unknown Allegiance'
}
