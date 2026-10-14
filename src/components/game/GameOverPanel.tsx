'use client'

import type { GameOverPresentation } from '@/lib/game/phase-theme'
import type { SafeRoom } from '@/lib/game/safe-room'
import type { ReactNode } from 'react'

export interface GameOverPanelProps {
    presentation: GameOverPresentation
    room: SafeRoom
    /** The caller's own role line, or null when the card is hidden. */
    ownRole: ReactNode
}

/**
 * Terminal victory/defeat screen.
 *
 * Presentation (colour, headline, copy) is chosen by the winning faction, not
 * by the viewer, so every player in the room reads the same outcome.
 */
export function GameOverPanel({ presentation, room, ownRole }: GameOverPanelProps) {
    return (
        <section
            aria-label="Game over"
            style={{ animation: 'gameOverIn 900ms cubic-bezier(0.22, 1, 0.36, 1) both' }}
            className={`relative overflow-hidden rounded-2xl border p-6 text-center shadow-2xl sm:p-8 ${presentation.surface} ${presentation.border}`}
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 -top-16 h-32 bg-[radial-gradient(50rem_12rem_at_50%_100%,rgba(255,255,255,0.10),transparent_70%)] motion-safe:animate-[secretCardAura_1.2s_ease-out_both]"
            />

            <p
                style={{
                    animation: 'gameOverHeadlineIn 800ms cubic-bezier(0.22, 1, 0.36, 1) 120ms both',
                }}
                className="text-[10px] font-bold uppercase tracking-[0.28em] text-slate-400"
            >
                Game Over · Round {room.roundNumber}
            </p>

            <p
                aria-hidden="true"
                style={{
                    animation: 'gameOverGlyphIn 700ms cubic-bezier(0.22, 1, 0.36, 1) 260ms both',
                }}
                className="mt-3 inline-block text-4xl"
            >
                {presentation.glyph}
            </p>

            <h1
                style={{
                    animation: 'gameOverHeadlineIn 900ms cubic-bezier(0.22, 1, 0.36, 1) 340ms both',
                }}
                className={`mt-2 font-mono text-2xl font-black uppercase sm:text-3xl ${presentation.accent}`}
            >
                {presentation.headline}
            </h1>

            <p
                style={{
                    animation: 'secretCardRise 500ms cubic-bezier(0.22, 1, 0.36, 1) 620ms both',
                }}
                className="mx-auto mt-2 max-w-sm text-sm text-slate-300"
            >
                {presentation.subline}
            </p>

            {ownRole && (
                <div
                    style={{
                        animation: 'secretCardRise 500ms cubic-bezier(0.22, 1, 0.36, 1) 760ms both',
                    }}
                    className="mt-5"
                >
                    {ownRole}
                </div>
            )}
        </section>
    )
}
