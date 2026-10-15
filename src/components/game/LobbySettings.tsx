'use client'

import { useMemo, useState } from 'react'

import type { PhaseTheme } from '@/lib/game/phase-theme'
import type { SafeRoom } from '@/lib/game/safe-room'
import { SETTINGS } from '@/lib/game/settings'
import {
    EDITABLE_ROLE_KEYS,
    compositionFromCounts,
    defaultPhaseSeconds,
    phaseSecondsBoundsFor,
    roleEntriesFromCounts,
    type EditableRoleKey,
    type PhaseKey,
} from '@/lib/game/room-settings'
import { validateRoleConfig } from '@/lib/game/config-validation'
import { getDefaultRoleConfig } from '@/lib/game/default-roles'

/** The three durations, in the order they are shown. */
const PHASE_FIELDS: Array<{ key: PhaseKey; label: string; hint: string }> = [
    { key: 'night', label: 'Night', hint: 'Werewolves, Guardian Angel and Seer act.' },
    { key: 'day', label: 'Day', hint: 'Discussion and accusations.' },
    { key: 'voting', label: 'Voting', hint: 'The village votes to exile.' },
]

const ROLE_LABELS: Record<EditableRoleKey, string> = {
    werewolf: 'Werewolves',
    seer: 'Seers',
    guardian_angel: 'Guardian Angels',
    hunter: 'Hunters',
    tanner: 'Tanners',
    mayor: 'Mayors',
    villager: 'Villagers',
}

export interface SettingsPayload {
    phaseSeconds: Record<PhaseKey, number>
    roles: Array<{ roleKey: string; roleCount: number; config: Record<string, unknown> }>
}

export interface LobbySettingsProps {
    theme: PhaseTheme
    room: SafeRoom
    isHost: boolean
    defaultExpanded?: boolean
    /** The active mutation key from the page, so Save cannot run alongside Start. */
    busyKey: string | null
    onSave: (payload: SettingsPayload) => Promise<void>
}

/**
 * Host-only game settings for the lobby.
 *
 * Every constraint the server enforces is also shown here, live, so the host
 * finds out before pressing Save rather than from a 400 afterwards — but this
 * component is a convenience, never the authority. The same two validators
 * (`validateRoleConfig`, `validatePhaseSeconds`) run in the settings route, and
 * the RPCs re-check under the rooms row lock.
 *
 * Local edits are deliberately NOT optimistic: the form holds its own draft
 * state and only adopts the server's values after a confirmed save or a
 * snapshot refresh, so a rejected save can never leave the panel displaying a
 * configuration the room does not actually have.
 */
export function LobbySettings({ theme, room, isHost, busyKey, onSave, defaultExpanded = false }: LobbySettingsProps) {
    const playerCount = room.players.length

    const savedDurations = room.phaseSeconds ?? defaultPhaseSeconds()
    const savedComposition = useMemo(
        () =>
            compositionFromCounts(
                room.roleCounts ?? undefined,
                playerCount,
                getDefaultRoleConfig(Math.max(playerCount, SETTINGS.gameplay.minStartablePlayers)),
            ),
        [room.roleCounts, playerCount],
    )

    const [draftDurations, setDraftDurations] = useState(savedDurations)

    const roleSummary = useMemo(() => {
        const counts = room.roleCounts ?? null;
        if (!counts) return null;
        const total = EDITABLE_ROLE_KEYS.reduce(
            (sum, key) => sum + (typeof counts[key] === 'number' ? (counts[key] as number) : 0),
            0,
        );
        if (total !== playerCount) return null;
        const labels: Record<EditableRoleKey, string> = {
            werewolf: 'Werewolf',
            seer: 'Seer',
            guardian_angel: 'Guardian Angel',
            hunter: 'Hunter',
            tanner: 'Tanner',
            mayor: 'Mayor',
            villager: 'Villager',
        };
        const parts: string[] = [];
        for (const key of EDITABLE_ROLE_KEYS) {
            const count = counts[key];
            if (typeof count !== 'number' || count <= 0) continue;
            parts.push(`${count} ${count === 1 ? labels[key] : labels[key] + 's'}`);
        }
        if (parts.length === 0) return null;
        return parts.join(' \u00b7 ');
    }, [room.roleCounts, playerCount]);

    const durationSummary = PHASE_FIELDS.every(({ key }) => {
        const value = draftDurations[key];
        const { min, max } = phaseSecondsBoundsFor(key);
        return Number.isInteger(value) && value >= min && value <= max;
    })
        ? PHASE_FIELDS.map(({ key }) => `${draftDurations[key]}s ${key === 'night' ? 'Night' : key === 'day' ? 'Day' : 'Voting'}`).join(' \u00b7 ')
        : null;

    const collapsedSummary = roleSummary && durationSummary
        ? `${durationSummary} \u2014 ${roleSummary}`
        : 'Settings unavailable';
    const [draftRoles, setDraftRoles] = useState(savedComposition)
    const [saving, setSaving] = useState(false)
    const [localError, setLocalError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState(defaultExpanded)

    const roleTotal = EDITABLE_ROLE_KEYS.reduce((sum, key) => sum + draftRoles[key], 0)
    const werewolfCount = draftRoles.werewolf

    const durationsValid = PHASE_FIELDS.every(({ key }) => {
        const value = draftDurations[key]
        const { min, max } = phaseSecondsBoundsFor(key)
        return Number.isInteger(value) && value >= min && value <= max
    })

    // The client check mirrors `validateRoleConfig`'s blocking rules: the counts
    // must match the roster exactly, and there must be at least one Werewolf.
    // Non-negative integers are guaranteed by the input's own constraints.
    const rolesValid =
        roleTotal === playerCount &&
        werewolfCount >= 1 &&
        roleTotal - werewolfCount >= 1

    const roleValidation = useMemo(
        () => validateRoleConfig(roleEntriesFromCounts(draftRoles), playerCount),
        [draftRoles, playerCount],
    )

    const isValid = durationsValid && rolesValid && roleValidation.ok
    const isBusy = saving || busyKey !== null

    const roleIssueMessage = roleValidation.ok
        ? null
        : roleValidation.issues.map((issue) => issue.message).join(' ')

    const handleSave = async () => {
        if (!isValid || isBusy) return
        setSaving(true)
        setLocalError(null)
        try {
            await onSave({
                phaseSeconds: { ...draftDurations },
                roles: roleEntriesFromCounts(draftRoles).map((entry) => ({
                    roleKey: entry.roleKey,
                    roleCount: entry.roleCount,
                    config: entry.config as Record<string, unknown>,
                })),
            })
        } finally {
            setSaving(false)
        }
    }

    return (
        <section
            aria-label="Game settings"
            className={`rounded-2xl border p-4 shadow-xl sm:p-5 ${theme.surface}`}
        >
            <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-label="Toggle game settings"
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${theme.border} ${theme.surfaceRaised}`}
            >
                <span className="flex items-center gap-2.5">
                    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span className={`text-xs font-bold uppercase tracking-[0.18em] ${theme.text}`}>
                        Game Settings
                    </span>
                </span>
                <span className="flex items-center gap-2">
                    {!expanded && (
                        <span className={`truncate text-[11px] ${theme.textMuted}`}>
                            {collapsedSummary}
                        </span>
                    )}
                    <svg aria-hidden="true" className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </span>
            </button>
            {isHost && (
                <span className={`mt-1 ml-1 inline-block text-[11px] ${theme.textMuted}`}>Host only</span>
            )}

            {expanded && (
                <>

            {/* --- Phase durations ------------------------------------------------ */}
            <fieldset className="mt-4" disabled={isBusy || !isHost}>
                <legend className={`text-[10px] font-bold uppercase tracking-[0.18em] ${theme.eyebrow}`}>
                    Phase durations
                </legend>
                <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {PHASE_FIELDS.map(({ key, label, hint }) => {
                        const { min, max } = phaseSecondsBoundsFor(key)
                        return (
                            <label key={key} className="flex flex-col gap-1">
                                <span className={`text-xs font-semibold ${theme.text}`}>{label}</span>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={min}
                                    max={max}
                                    step={1}
                                    value={draftDurations[key]}
                                    onChange={(event) => {
                                        const next = Number(event.target.value)
                                        setDraftDurations((prev) => ({
                                            ...prev,
                                            [key]: Number.isFinite(next) ? next : min,
                                        }))
                                    }}
                                    aria-label={`${label} duration in seconds`}
                                    aria-invalid={!durationsValid}
                                    className={`w-full rounded-lg border px-2.5 py-2 font-mono text-sm ${theme.border} bg-black/20 ${theme.text} focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60`}
                                />
                                <span className={`text-[10px] ${theme.textFaint}`}>
                                    {min}–{max}s · {hint}
                                </span>
                            </label>
                        )
                    })}
                </div>
            </fieldset>

            {/* --- Role composition ------------------------------------------------ */}
            <fieldset className="mt-5" disabled={isBusy || !isHost}>
                <legend className={`text-[10px] font-bold uppercase tracking-[0.18em] ${theme.eyebrow}`}>
                    Roles
                </legend>
                <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-6">
                    {EDITABLE_ROLE_KEYS.map((key) => (
                        <label key={key} className="flex flex-col gap-1">
                            <span className={`text-xs font-semibold ${theme.text}`}>
                                {ROLE_LABELS[key]}
                            </span>
                            <input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={playerCount}
                                step={1}
                                value={draftRoles[key]}
                                onChange={(event) => {
                                    const next = Number(event.target.value)
                                    setDraftRoles((prev) => ({
                                        ...prev,
                                        [key]: Number.isFinite(next)
                                            ? Math.max(0, Math.floor(next))
                                            : 0,
                                    }))
                                }}
                                aria-label={`Number of ${ROLE_LABELS[key]}`}
                                aria-invalid={!rolesValid}
                                className={`w-full rounded-lg border px-2.5 py-2 font-mono text-sm ${theme.border} bg-black/20 ${theme.text} focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60`}
                            />
                        </label>
                    ))}
                </div>

                <p
                    className={`mt-2 text-[11px] ${
                        rolesValid ? theme.textMuted : theme.isLight ? 'text-amber-700' : 'text-amber-300'
                    }`}
                    role="status"
                >
                    {roleTotal} of {playerCount} players assigned
                    {roleTotal !== playerCount
                        ? ` — ${Math.abs(playerCount - roleTotal)} more ${
                              playerCount > roleTotal ? 'needed' : 'to remove'
                          }.`
                        : werewolfCount < 1
                          ? ' — at least one Werewolf is required.'
                          : ''}
                </p>
                {roleIssueMessage && (
                    <p
                        className={`mt-1.5 text-[11px] ${theme.isLight ? 'text-rose-700' : 'text-rose-300'}`}
                        role="alert"
                    >
                        {roleIssueMessage}
                    </p>
                )}
            </fieldset>

            {/* --- Save ------------------------------------------------------------ */}
            {isHost && (
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!isValid || isBusy}
                    className={`rounded-xl border px-4 py-2.5 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none ${theme.buttonPrimary}`}
                >
                    {saving ? (
                        <span className="inline-flex items-center gap-2">
                            <span
                                aria-hidden="true"
                                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                            />
                            Saving…
                        </span>
                    ) : (
                        'Save settings'
                    )}
                </button>
            </div>
            )}

            {localError && (
                <p
                    className={`mt-2 text-[11px] ${theme.isLight ? 'text-rose-700' : 'text-rose-300'}`}
                    role="alert"
                >
                    {localError}
                </p>
            )}
                </>
            )}
        </section>
    )
}
