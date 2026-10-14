/**
 * Cinematic phase transitions.
 *
 * A transition announcement is an *event*, not a piece of state derived from
 * the current phase. It must fire only when the authoritative phase genuinely
 * changes inside one room/game, and must never fire because of:
 *
 *   - the first snapshot after page load (there is no "previous" phase to
 *     transition from, and replaying history would be noise),
 *   - a Realtime event or poll that returns the same phase,
 *   - a reconnect that re-reads the same phase,
 *   - navigating to a different room or game instance.
 *
 * So the reducer tracks the last observed scope *and* the last observed phase
 * key, and only mints an announcement when the key moves inside an unchanged
 * scope. Pure module: no React, no timers, no DOM.
 */

import type { PhaseThemeKey } from './phase-theme'

export type { PhaseThemeKey }

/**
 * Phases that earn a centered announcement overlay.
 *
 * `gameover` is deliberately absent: the Game Over panel is itself the final
 * cinematic entrance, so playing a banner underneath it would be two competing
 * reveals. Its key is still tracked, so a direct `night -> finished` jump is
 * handled exactly once.
 */
export type AnnouncedPhase = 'night' | 'day' | 'voting'

export interface PhaseAnnouncement {
    /** Monotonic id; a stale dismissal timer can never clear a newer banner. */
    id: number
    key: AnnouncedPhase
    headline: string
    subline: string
    glyph: string
    roundNumber: number
}

export interface PhaseTransitionState {
    /** Scope the observation belongs to (see `secretRoleScope`). */
    scope: string | null
    /** Last phase key seen for this scope. */
    lastKey: PhaseThemeKey | null
    /** Currently playing announcement, if any. */
    active: PhaseAnnouncement | null
    /** Monotonic counter backing `PhaseAnnouncement.id`. */
    sequence: number
}

export const initialPhaseTransitionState: PhaseTransitionState = {
    scope: null,
    lastKey: null,
    active: null,
    sequence: 0,
}

export type PhaseTransitionAction =
    | {
          type: 'observed'
          scope: string
          key: PhaseThemeKey
          roundNumber: number
      }
    | { type: 'dismissed'; id: number }
    | { type: 'cleared' }

/**
 * How long each announcement phase runs, in ms.
 *
 * These three stages are the single source of truth: the CSS keyframe stop
 * positions in `globals.css` are derived from them (and a test asserts the two
 * stay in step), and the auto-dismiss timer is computed from the same numbers.
 * Previously the CSS animation ran for 1040ms while the dismissal timer waited
 * 2400ms, so an invisible full-screen wrapper lingered for over a second after
 * the banner had already faded out.
 *
 *   entrance  900ms  ease-out, rises into place
 *   hold     2600ms  fully visible and exactly centred
 *   exit      800ms  ease-in, lifts away
 */
export const PHASE_ANNOUNCEMENT_STAGES = {
    entranceMs: 900,
    holdMs: 2600,
    exitMs: 800,
} as const

/** Total on-screen time of a full announcement sequence. */
export const PHASE_ANNOUNCEMENT_TOTAL_MS =
    PHASE_ANNOUNCEMENT_STAGES.entranceMs +
    PHASE_ANNOUNCEMENT_STAGES.holdMs +
    PHASE_ANNOUNCEMENT_STAGES.exitMs

/**
 * Total time for each announced phase.
 *
 * Every phase uses the identical duration and easing so the rhythm is
 * consistent across Night, Day and Voting.
 */
export const PHASE_ANNOUNCEMENT_MS: Record<AnnouncedPhase, number> = {
    night: PHASE_ANNOUNCEMENT_TOTAL_MS,
    day: PHASE_ANNOUNCEMENT_TOTAL_MS,
    voting: PHASE_ANNOUNCEMENT_TOTAL_MS,
}

const CONTENT: Record<AnnouncedPhase, { headline: string; subline: string; glyph: string }> = {
    night: {
        headline: 'Night Falls',
        subline: 'The village sleeps. Make your choice.',
        glyph: '🌙',
    },
    day: {
        headline: 'Daybreak',
        subline: 'The village wakes to find someone missing.',
        glyph: '☀️',
    },
    voting: {
        headline: 'The Vote',
        subline: 'Choose who the village believes.',
        glyph: '⚖️',
    },
}

/**
 * Lobby is a silent beat. Game Over is silent here too — the panel animates.
 */
export function isAnnouncedPhase(key: PhaseThemeKey): key is AnnouncedPhase {
    return key === 'night' || key === 'day' || key === 'voting'
}

export function phaseTransitionReducer(
    state: PhaseTransitionState,
    action: PhaseTransitionAction
): PhaseTransitionState {
    switch (action.type) {
        case 'observed': {
            if (state.scope !== action.scope) {
                // New room or new game instance: adopt the phase silently. There is no
                // transition to play, so an active banner from the old scope is dropped.
                return {
                    scope: action.scope,
                    lastKey: action.key,
                    active: null,
                    sequence: state.sequence,
                }
            }

            if (state.lastKey === action.key) {
                // Ordinary Realtime event / poll / reconnect. A banner already on
                // screen keeps playing untouched — returning `state` preserves its
                // identity so no animation restarts.
                return state
            }

            if (!isAnnouncedPhase(action.key)) {
                // lobby / gameover: the transition is silent, but the key is recorded so
                // the next real change is detected against the right baseline.
                return { ...state, lastKey: action.key, active: null }
            }

            const nextSequence = state.sequence + 1
            return {
                scope: action.scope,
                lastKey: action.key,
                sequence: nextSequence,
                active: {
                    id: nextSequence,
                    key: action.key,
                    roundNumber: action.roundNumber,
                    ...CONTENT[action.key],
                },
            }
        }

        case 'dismissed': {
            if (!state.active || state.active.id !== action.id) return state
            return { ...state, active: null }
        }

        case 'cleared': {
            return state.active === null ? state : { ...state, active: null }
        }

        default:
            return state
    }
}

/** True while an announcement should be painted. */
export function hasActiveAnnouncement(state: PhaseTransitionState): boolean {
    return state.active !== null
}

/** How long the current announcement should stay before it auto-dismisses. */
export function announcementDurationMs(state: PhaseTransitionState): number {
    return state.active ? PHASE_ANNOUNCEMENT_MS[state.active.key] : 0
}
