'use client'

import { useState, useSyncExternalStore } from 'react'

import { AnimatePresence, motion, type Variants } from 'motion/react'

import { FlipCard } from '@/components/animate-ui/components/community/flip-card'
import { getRoleCharacterArtwork } from '@/lib/game/role-artwork'
import type { PhaseTheme } from '@/lib/game/phase-theme'
import {
    getRoleTeamLabel,
    getSecretRolePresentation,
    type SecretRoleEmblem,
} from '@/lib/game/secret-role-card'

export interface SecretRoleInvestigation {
    roundNumber: number
    result: { targetPlayerId: string; alignment: string }
}

export interface SecretRoleCardProps {
    roleKey: string | null
    alignment: string | null
    investigations?: SecretRoleInvestigation[]
    players?: Array<{ id: string; displayName: string }>
    theme: PhaseTheme
}

/* ---------------------------------------------------------------------------
 * Emblems — each role keeps a distinct, readable silhouette at 20–48px.
 * ------------------------------------------------------------------------- */

/**
 * The card lifts in with a slight rise and settle. `closing` adds a gentle
 * shrink so the unmount reads as intentional rather than a hard cut.
 */
const cardShellVariants: Variants = {
    // Deliberately no opacity: the server-rendered HTML must never ship the
    // card at opacity 0, or the role is invisible until hydration finishes.
    // The rise + scale reads as an arrival, and the scrim carries the fade.
    enter: { y: 26, scale: 0.94 },
    rest: { y: 0, scale: 1 },
}

const EMBLEMS: Record<SecretRoleEmblem, React.ReactNode> = {
    werewolf: (
        <svg viewBox="0 0 48 48" aria-hidden="true" className="h-full w-full">
            {/* Ears */}
            <path
                d="M9 15 12.5 5l8 5.5M39 15 35.5 5l-8 5.5"
                fill="currentColor"
                fillOpacity="0.85"
            />
            {/* Muzzle */}
            <path
                d="M24 13c8.5 0 14 5.8 14 13.2 0 8.4-6.6 14.8-14 14.8S10 34.6 10 26.2C10 18.8 15.5 13 24 13Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
            />
            {/* Eyes */}
            <path d="M15.5 24.5 20.5 23l-4.6 3.4zM32.5 24.5 27.5 23l4.6 3.4z" fill="currentColor" />
            {/* Snout + fang */}
            <path
                d="M24 29v4M20 36.5h8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    ),
    seer: (
        <svg viewBox="0 0 48 48" aria-hidden="true" className="h-full w-full">
            {/* Crescent moon */}
            <path
                d="M30 7a15 15 0 1 0 9.5 26.8A16.5 16.5 0 0 1 30 7Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
            />
            {/* All-seeing eye */}
            <path
                d="M12 31s5.5-7 13-7 13 7 13 7-5.5 7-13 7-13-7-13-7Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
            />
            <circle cx="25" cy="31" r="3.4" fill="currentColor" />
            {/* Star */}
            <path d="M38 15.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" fill="currentColor" />
        </svg>
    ),
    doctor: (
        <svg viewBox="0 0 48 48" aria-hidden="true" className="h-full w-full">
            {/* Protective shield */}
            <path
                d="M24 5.5 39 11v11.5c0 9.2-6.2 16.4-15 19-8.8-2.6-15-9.8-15-19V11Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinejoin="round"
            />
            {/* Vital cross */}
            <path
                d="M24 17v14M17 24h14"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
            />
        </svg>
    ),
    villager: (
        <svg viewBox="0 0 48 48" aria-hidden="true" className="h-full w-full">
            {/* Lantern body */}
            <path
                d="M15 16h18l2.5 20H12.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinejoin="round"
            />
            {/* Handle */}
            <path
                d="M19 16v-2a5 5 0 0 1 10 0v2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
            />
            {/* Flame */}
            <path
                d="M24 21c2.8 2.6 4 4.4 4 6.2a4 4 0 0 1-8 0c0-1.8 1.2-3.6 4-6.2Z"
                fill="currentColor"
            />
            {/* Base */}
            <path d="M13 36h22" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
    ),
}

/**
 * Card back: five moon phases in a clear band between two lattice strips,
 * inside a chamfered double frame. Reads as "the night is passing, the role
 * is hidden". Everything is drawn in currentColor, so `presentation.backMotif`
 * still sets the colour.
 */
function CardBack() {
    // Lit side of a crescent: outer arc radius r, inner arc radius ri.
    const crescent = (cx: number, r: number, ri: number) =>
        `M${cx} ${60 - r}A${r} ${r} 0 0 0 ${cx} ${60 + r}A${ri} ${r} 0 0 1 ${cx} ${60 - r}Z`

    return (
        <svg viewBox="0 0 200 120" aria-hidden="true" className="h-full w-full">
            <defs>
                <pattern
                    id="secretCardGuilloche"
                    width="12"
                    height="12"
                    patternUnits="userSpaceOnUse"
                >
                    <path
                        d="M0 6 6 0l6 6-6 6Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="0.5"
                        strokeOpacity="0.3"
                    />
                </pattern>
            </defs>

            {/* Lattice strips above and below the moon band */}
            <rect x="14" y="14" width="172" height="24" fill="url(#secretCardGuilloche)" />
            <rect x="14" y="82" width="172" height="24" fill="url(#secretCardGuilloche)" />

            {/* Band rules */}
            <path
                d="M14 38H186M14 82H186"
                stroke="currentColor"
                strokeWidth="0.75"
                strokeOpacity="0.45"
            />

            {/* Chamfered double frame */}
            <path
                d="M14 8H186L192 14V106L186 112H14L8 106V14Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeOpacity="0.75"
            />
            <path
                d="M18 14H182L186 18V102L182 106H18L14 102V18Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.75"
                strokeOpacity="0.45"
            />

            {/* Moon phases: dark side outlined, lit side filled */}
            <g fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity="0.55">
                <circle cx="36" cy="60" r="9" />
                <circle cx="68" cy="60" r="9" />
                <circle cx="100" cy="60" r="14" strokeOpacity="0.85" />
                <circle cx="132" cy="60" r="9" />
                <circle cx="164" cy="60" r="9" />
            </g>

            <g fill="currentColor" fillOpacity="0.85">
                {/* Waxing crescent */}
                <path d={crescent(68, 9, 4.5)} />
                {/* Full moon */}
                <circle cx="100" cy="60" r="14" />
                {/* Waning crescent, mirrored around its own centre */}
                <path d={crescent(132, 9, 4.5)} transform="translate(264 0) scale(-1 1)" />
            </g>
        </svg>
    )
}

/* ---------------------------------------------------------------------------
 * Reduced motion
 * ------------------------------------------------------------------------- */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
}

function getReducedMotionSnapshot(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function getReducedMotionServerSnapshot(): boolean {
    return false
}

function usePrefersReducedMotion(): boolean {
    return useSyncExternalStore(
        subscribeToReducedMotion,
        getReducedMotionSnapshot,
        getReducedMotionServerSnapshot
    )
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

export function SecretRoleCard({
    roleKey,
    alignment,
    investigations = [],
    players = [],
    theme,
}: SecretRoleCardProps) {
    const prefersReducedMotion = usePrefersReducedMotion()
    const presentation = getSecretRolePresentation(roleKey)
    // Framer Motion drives the card. A hand-tuned easing (no bounce on the
    // 3D turn, slight settle afterwards) reads far better than the old
    // linear-ish CSS keyframes, which made the flip look mechanical.
    const arriveTransition = prefersReducedMotion
        ? { duration: 0 }
        : { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const }

    // Set when an artwork file fails to load, so the card degrades to the inline
    // SVG emblem instead of showing a broken image. Reset whenever the role
    // changes so a new role gets a fresh attempt at its artwork.
    const [artworkFailed, setArtworkFailed] = useState(false)
    const [failedForRole, setFailedForRole] = useState<string | null>(null)
    if (failedForRole !== roleKey) {
        setFailedForRole(roleKey)
        setArtworkFailed(false)
    }

    // There is no staged reveal any more: FlipCard turns on hover/focus, so
    // every role part is mounted and simply settles in.
    const settlePart = (index: number): React.CSSProperties => {
        if (prefersReducedMotion) return { animation: 'secretCardFade 160ms ease-out' }
        return {
            animation: `secretCardRise 320ms cubic-bezier(0.22, 1, 0.36, 1) ${index * 110}ms backwards`,
        }
    }

    const emblemStyle = (): React.CSSProperties =>
        prefersReducedMotion
            ? { animation: 'secretCardFade 200ms ease-out' }
            : { animation: 'secretCardEmblemShimmer 5s ease-in-out 400ms 2' }

    // Both faces carry the card's chrome so the whole card turns as one piece
    // rather than the contents spinning inside a static frame.
    const cardChrome = `h-full w-full overflow-hidden rounded-xl border ${presentation.accentBorder} bg-gradient-to-b ${presentation.accentSoftBg} via-[#0f1420] to-[#0a0e17] shadow-xl ${presentation.accentGlow}`

    const artworkSrc = getRoleCharacterArtwork(roleKey)
    const showArtwork = artworkSrc !== null && !artworkFailed
    const artworkAlt = `${presentation.title} character portrait`

    return (
        <>
            {/* Stage 1 — dim the surrounding gameplay while the card holds focus.

          Two deliberate choices keep this from ever eating a gameplay click:
          1. `pointer-events-none` on the layer itself.
          2. NO `backdrop-filter`. A full-screen `backdrop-filter` promotes the
             element to its own compositing layer, and Chromium/WebKit are known
             to let that layer capture hit-testing through ancestor
             `pointer-events: none` (Chromium 1139474 / WebKit 204908). A plain
             translucent fill dims just as well and cannot trap input.

          Mounted only while the card is concealed or flipping; the lifecycle
          fix above guarantees it is torn down when settling begins. */}
            <div className="relative">
                {/* Stage 2 — ambient bloom behind the focused card. */}
                <AnimatePresence>
                    {!prefersReducedMotion && (
                        <motion.div
                            aria-hidden="true"
                            initial={false}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.08 }}
                            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                            className={`pointer-events-none absolute -inset-8 -z-10 rounded-[2rem] blur-2xl ${presentation.auraBg}`}
                        />
                    )}
                </AnimatePresence>

                <motion.div
                    aria-label="Your secret role"
                    role="group"
                    data-testid="secret-role-card"
                    variants={cardShellVariants}
                    initial="enter"
                    animate="rest"
                    transition={arriveTransition}
                    className="h-full"
                >
                    {/*
                        The card's chrome (border, gradient, glow) lives inside each
                        face so the whole card turns, not just its contents. The
                        wrapper above stays static and carries no visible styling.

                        FlipCard shows `front` at rest and turns to `back` on hover:
                        the resting face is the ornate card back, and hovering is
                        what turns your role over to you.
                    */}
                    <FlipCard
                        reducedMotion={prefersReducedMotion}
                        className="h-full"
                        front={
                            <div aria-hidden="true" className={`${cardChrome} bg-[#10131f]`}>
                                <div
                                    className={`h-full w-full p-2 opacity-70 ${presentation.backMotif}`}
                                >
                                    <CardBack />
                                </div>
                            </div>
                        }
                        back={
                            <div className={`${cardChrome} flex flex-col justify-center`}>
                                {/*
                                    Tarot-style layout: art first, name in a banner beneath it.
                                    A thin inner frame (mat) holds corner marks, the artwork and the
                                    title, so the card reads as one printed object.
                                */}
                                <div className="m-2.5 rounded-md border border-white/15 p-2.5">
                                    {/* Corner marks: emblem left, faction right. Small on purpose. */}
                                    <div className="mb-2.5 flex items-center justify-between gap-2">
                                        <span
                                            style={emblemStyle()}
                                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/40 ${presentation.accentText}`}
                                        >
                                            <span className="block h-4 w-4">
                                                {EMBLEMS[presentation.emblem]}
                                            </span>
                                        </span>

                                        <span
                                            style={settlePart(2)}
                                            className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold leading-none ${presentation.factionBadge}`}
                                        >
                                            {getRoleTeamLabel(alignment)}
                                        </span>
                                    </div>

                                    {/* Character artwork: locked 3:4 frame, whole character always visible. */}
                                    <div style={settlePart(2)} className="flex justify-center">
                                        <div className="aspect-[3/4] h-44 max-w-full overflow-hidden rounded-sm border border-white/25 bg-black/50 ring-1 ring-inset ring-black/40 sm:h-56">
                                            {showArtwork && artworkSrc ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img
                                                    src={artworkSrc}
                                                    alt={artworkAlt}
                                                    loading="lazy"
                                                    decoding="async"
                                                    data-testid="secret-role-artwork"
                                                    onError={() => setArtworkFailed(true)}
                                                    className="h-full w-full object-contain object-top"
                                                />
                                            ) : (
                                                <div
                                                    data-testid="secret-role-artwork-fallback"
                                                    className={`flex h-full w-full items-center justify-center ${presentation.accentText}`}
                                                >
                                                    <span className="h-14 w-14 opacity-90 sm:h-16 sm:w-16">
                                                        {EMBLEMS[presentation.emblem]}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <p
                                    style={settlePart(3)}
                                    className="mx-auto max-w-[40ch] px-4 pb-5 pt-1.5 text-center text-xs leading-relaxed text-slate-300 text-pretty"
                                >
                                    {presentation.description}
                                </p>
                            </div>
                        }
                    />

                    {investigations.length > 0 &&
                        (() => {
                            const wolfCount = investigations.filter(
                                (i) => i.result.alignment === 'werewolf'
                            ).length
                            const villageCount = investigations.length - wolfCount

                            // Newest first: the latest divination is the one the
                            // seer is reasoning about right now. Every row stays
                            // visible — a seer must be able to re-scan their own
                            // notes without navigating.
                            const ordered = [...investigations].sort(
                                (a, b) => b.roundNumber - a.roundNumber
                            )

                            return (
                                <section
                                    aria-label="Investigation log"
                                    style={settlePart(4)}
                                    className={`mt-3 rounded-2xl border p-3 shadow-xl sm:p-4 ${theme.surface}`}
                                >
                                    <div
                                        className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-2.5 ${theme.divider}`}
                                    >
                                        <h2
                                            className={`text-[11px] font-bold uppercase tracking-[0.18em] ${theme.text}`}
                                        >
                                            Investigation Log
                                        </h2>
                                        <span className={`font-mono text-[11px] ${theme.textMuted}`}>
                                            <span className="text-rose-300">{wolfCount}</span>
                                            {' · '}
                                            <span className="text-emerald-300">{villageCount}</span>
                                        </span>
                                    </div>

                                    <ul className="mt-2 flex flex-col">
                                        {ordered.map((investigation, index) => {
                                            const target = players.find(
                                                (player) =>
                                                    player.id ===
                                                    investigation.result.targetPlayerId
                                            )
                                            const isWolf =
                                                investigation.result.alignment === 'werewolf'
                                            return (
                                                <li
                                                    key={`${investigation.roundNumber}-${investigation.result.targetPlayerId}`}
                                                    className={`flex items-center gap-3 py-1.5 ${
                                                        index > 0 ? theme.divider : ''
                                                    }`}
                                                >
                                                    <span
                                                        className={`w-9 shrink-0 font-mono text-[11px] font-bold ${theme.textMuted}`}
                                                    >
                                                        R{investigation.roundNumber}
                                                    </span>
                                                    <span
                                                        className={`min-w-0 flex-1 truncate text-sm font-semibold ${theme.text}`}
                                                    >
                                                        {target?.displayName ?? 'Unknown'}
                                                    </span>
                                                    <span
                                                        className={`flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider ${
                                                            isWolf ? 'text-rose-300' : 'text-emerald-300'
                                                        }`}
                                                    >
                                                        <span aria-hidden="true">
                                                            {isWolf ? '🐺' : '🏘'}
                                                        </span>
                                                        {isWolf ? 'Werewolf' : 'Village'}
                                                    </span>
                                                </li>
                                            )
                                        })}
                                    </ul>
                                </section>
                            )
                        })()}
                </motion.div>
            </div>
        </>
    )
}
