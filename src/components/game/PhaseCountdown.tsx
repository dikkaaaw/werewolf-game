'use client'

import { useEffect, useState } from 'react'

import type { PhaseTheme } from '@/lib/game/phase-theme'

export interface PhaseCountdownProps {
    /** The authoritative deadline from the server. Null when no deadline applies. */
    phaseEndsAt: string | null | undefined
    /** Whether a countdown is meaningful right now (in-progress game only). */
    active: boolean
    theme: PhaseTheme
    /** Fired exactly once when the deadline passes, so the page can advance. */
    onExpired: () => void
}

/**
 * The phase countdown, isolated so it is the only thing that re-renders each
 * second.
 *
 * It used to live inline in the room page, where the 1s `setSecondsRemaining`
 * tick re-rendered the whole tree — LobbyPanel, PlayerRoster, the 512-line
 * SecretRoleCard and the chat shell — sixty times a minute, for a number that
 * changes in one small label. Keeping the tick local means a mid-game second
 * costs a few dozen DOM nodes instead of the entire room.
 *
 * The deadline is never trusted by game logic: it is display-only, and the
 * server owns phase transitions (see src/lib/game/phase-manager.ts). When it
 * reaches zero this component simply notifies the page once; the page's
 * `requestRefresh({force:true})` is what actually drives lazy advancement.
 */
export function PhaseCountdown({ phaseEndsAt, active, theme, onExpired }: PhaseCountdownProps) {
    const [seconds, setSeconds] = useState<number | null>(null)

    useEffect(() => {
        if (!active || !phaseEndsAt) {
            // Inactive phase renders nothing (see below), so no reset is needed.
            // Settling the state here would only re-trigger the lint rule against
            // synchronously updating during the effect.
            return
        }

        const deadline = new Date(phaseEndsAt).getTime()
        let expiredTriggered = false

        const tick = () => {
            const remainingMs = deadline - Date.now()
            const next = Math.max(0, Math.ceil(remainingMs / 1000))
            setSeconds(next)

            if (next <= 0 && !expiredTriggered) {
                expiredTriggered = true
                onExpired()
            }
        }

        tick()
        const interval = window.setInterval(tick, 1000)
        return () => window.clearInterval(interval)
    }, [phaseEndsAt, active, onExpired])

    if (!active || seconds === null) return null

    const isLow = seconds <= 10

    return (
        <div className="text-right" role="timer" aria-live="off">
            <p
                className={`text-[10px] font-bold uppercase tracking-[0.2em] ${theme.eyebrow}`}
            >
                Time left
            </p>
            <p
                className={`mt-0.5 font-mono text-3xl font-black tabular-nums leading-none sm:text-4xl ${
                    isLow ? theme.accent : theme.text
                }`}
            >
                {seconds}s
            </p>
        </div>
    )
}
