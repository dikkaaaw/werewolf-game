'use client'

import { SETTINGS } from '@/lib/game/settings'
import type { PhaseTheme } from '@/lib/game/phase-theme'
import { isSameUser, type SafePlayer, type SafeRoom } from '@/lib/game/safe-room'

/**
 * The start threshold, aliased for the template. Pulled from SETTINGS rather
 * than typed as a literal so the lobby copy cannot disagree with the start route
 * or the start_game RPC.
 */
const MIN_STARTABLE = SETTINGS.gameplay.minStartablePlayers

export interface LobbyPanelProps {
    theme: PhaseTheme
    room: SafeRoom
    isHost: boolean
    isSelfReady: boolean
    canStart: boolean
    copied: boolean
    busyKey: string | null
    currentUserId: string | undefined
    onCopyCode: () => void
    onToggleReady: () => void
    onStartGame: () => void
    onDevAddBots: (count: number) => void
}

function capacityTone(current: number, max: number): string {
    if (current >= max) return 'bg-amber-500'
    if (current >= 4) return 'bg-emerald-500'
    return 'bg-slate-500'
}

/**
 * Lobby presentation.
 *
 * Deliberately roomier than the in-game roster: a waiting room should feel
 * welcoming and scannable, with the room code, capacity, roster, and host
 * controls each in their own clearly-labelled section rather than crammed into
 * one dense block.
 */
export function LobbyPanel({
    theme,
    room,
    isHost,
    isSelfReady,
    canStart,
    copied,
    busyKey,
    currentUserId,
    onCopyCode,
    onToggleReady,
    onStartGame,
    onDevAddBots,
}: LobbyPanelProps) {
    const playerCount = room.players.length
    const readyCount = room.players.filter((player) => player.isReady).length
    const fillPercent = Math.min(100, Math.round((playerCount / room.maxPlayers) * 100))
    const roomFull = playerCount >= room.maxPlayers

    return (
        <div className="flex flex-col gap-5">
            {/* --- Room identity: code, capacity, host --- */}
            <section
                aria-label="Room details"
                className={`rounded-2xl border p-5 shadow-xl sm:p-6 ${theme.surface} ${theme.accentGlow}`}
            >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <p
                            className={`text-[10px] font-bold uppercase tracking-[0.22em] ${theme.eyebrow}`}
                        >
                            Room Code
                        </p>
                        <div className="mt-1.5 flex items-center gap-3">
                            <span
                                className={`font-mono text-3xl font-black tracking-[0.2em] sm:text-4xl ${theme.accent}`}
                            >
                                {room.roomCode}
                            </span>
                            <button
                                type="button"
                                onClick={onCopyCode}
                                aria-label={`Copy room code ${room.roomCode}`}
                                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${theme.buttonNeutral} focus-visible:ring-current`}
                            >
                                {copied ? '✓ Copied' : 'Copy'}
                            </button>
                        </div>
                        <p className={`mt-2 text-xs ${theme.textMuted}`}>
                            Share this code so friends can join the village.
                        </p>
                    </div>

                    <div className="w-full sm:w-56">
                        <div className="flex items-baseline justify-between">
                            <span
                                className={`text-[10px] font-bold uppercase tracking-[0.18em] ${theme.eyebrow}`}
                            >
                                Capacity
                            </span>
                            <span className={`font-mono text-sm font-bold ${theme.text}`}>
                                {playerCount}
                                <span className={`font-normal ${theme.textFaint}`}>
                                    /{room.maxPlayers}
                                </span>
                            </span>
                        </div>
                        <div
                            role="progressbar"
                            aria-valuenow={playerCount}
                            aria-valuemin={0}
                            aria-valuemax={room.maxPlayers}
                            aria-label="Room capacity"
                            className={`mt-1.5 h-2 w-full overflow-hidden rounded-full border ${theme.border} bg-black/20`}
                        >
                            <div
                                className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${capacityTone(playerCount, room.maxPlayers)}`}
                                style={{
                                    width: `${Math.max(fillPercent, playerCount > 0 ? 6 : 0)}%`,
                                }}
                            />
                        </div>
                        <p className={`mt-1.5 text-[11px] ${theme.textMuted}`}>
                            {playerCount < MIN_STARTABLE
                                ? `${MIN_STARTABLE - playerCount} more needed to start (min ${MIN_STARTABLE})`
                                : readyCount < playerCount
                                  ? `${playerCount - readyCount} still getting ready`
                                  : 'Everyone is ready'}
                        </p>
                    </div>
                </div>
            </section>

            {/* --- Roster: spacious scannable player cards --- */}
            <section
                aria-label="Players"
                className={`rounded-2xl border p-5 shadow-xl sm:p-6 ${theme.surface}`}
            >
                <div
                    className={`flex items-baseline justify-between border-b pb-3 ${theme.divider}`}
                >
                    <h2 className={`text-sm font-bold uppercase tracking-[0.18em] ${theme.text}`}>
                        Village
                    </h2>
                    <span className={`font-mono text-xs ${theme.textMuted}`}>
                        {readyCount}/{playerCount} ready
                    </span>
                </div>

                {playerCount === 0 ? (
                    <p className={`py-6 text-center text-sm ${theme.textMuted}`}>
                        No one has arrived yet. Share the room code to invite players.
                    </p>
                ) : (
                    <ul className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        {room.players.map((player) => (
                            <PlayerCard
                                key={player.id}
                                player={player}
                                theme={theme}
                                isSelf={isSameUser(player, currentUserId)}
                                isHostSeat={isSameUser(player, room.hostUserId)}
                            />
                        ))}
                    </ul>
                )}
            </section>

            {/* --- Controls: host start is the primary position --- */}
            <section
                aria-label="Lobby controls"
                className={`rounded-2xl border p-5 shadow-xl sm:p-6 ${theme.surface}`}
            >
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <button
                            type="button"
                            onClick={onToggleReady}
                            disabled={busyKey !== null}
                            aria-pressed={isSelfReady}
                            className={`flex-1 rounded-xl cursor-pointer border px-4 py-3 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 motion-reduce:transition-none ${
                                isSelfReady
                                    ? 'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white border-emerald-500 shadow-lg shadow-emerald-950/40'
                                    : `${theme.buttonNeutral} hover:brightness-110`
                            }`}
                        >
                            {busyKey === 'ready' ? (
                                <span className="inline-flex items-center gap-2">
                                    <Spinner />
                                    Updating…
                                </span>
                            ) : isSelfReady ? (
                                'Ready — tap to unready'
                            ) : (
                                'I’m ready'
                            )}
                        </button>

                        {isHost ? (
                            <button
                                type="button"
                                onClick={onStartGame}
                                disabled={busyKey !== null || !canStart}
                                className={`flex-1 rounded-xl border px-4 py-3 cursor-pointer text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none ${theme.buttonPrimary}`}
                            >
                                {busyKey === 'start' ? (
                                    <span className="inline-flex items-center gap-2">
                                        <Spinner />
                                        Starting…
                                    </span>
                                ) : (
                                    '▶ Start Game'
                                )}
                            </button>
                        ) : (
                            <div
                                className={`flex-1 rounded-xl border border-dashed px-4 py-3 text-center text-sm ${theme.border} ${theme.textMuted}`}
                            >
                                Waiting for the host to start
                            </div>
                        )}
                    </div>

                    <p className={`text-center text-[11px] ${theme.textFaint}`}>
                        {canStart
                            ? 'All set. Starting deals everyone their secret role.'
                            : `The game unlocks once at least ${MIN_STARTABLE} players have joined and everyone is ready.`}
                    </p>

                    {process.env.NODE_ENV === 'development' && isHost && (
                        <div
                            className={`flex items-center justify-between gap-2 border-t border-dashed pt-3 ${theme.divider}`}
                        >
                            <span className={`font-mono text-[10px] ${theme.eyebrow}`}>
                                Dev harness
                            </span>
                            <div className="flex gap-2">
                                {/* <button
                                    type="button"
                                    onClick={() => onDevAddBots(1)}
                                    disabled={busyKey !== null || roomFull}
                                    className={`rounded-lg border px-2.5 py-1 text-[11px] transition disabled:opacity-40 ${theme.buttonNeutral}`}
                                >
                                    +1 Bot
                                </button> */}
                                <button
                                    type="button"
                                    onClick={() => onDevAddBots(4)}
                                    disabled={busyKey !== null || roomFull}
                                    className={`rounded-lg border px-2.5 py-1 text-[11px] transition disabled:opacity-40 ${theme.buttonNeutral}`}
                                >
                                    +4 Bots
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </section>
        </div>
    )
}

function PlayerCard({
    player,
    theme,
    isSelf,
    isHostSeat,
}: {
    player: SafePlayer
    theme: PhaseTheme
    isSelf: boolean
    isHostSeat: boolean
}) {
    const isReady = player.isReady ?? false
    return (
        <li
            className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition ${
                isReady
                    ? `${theme.surfaceRaised} ${theme.accentBorder}`
                    : `${theme.surfaceRaised} opacity-75`
            }`}
        >
            <span
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border font-mono text-xs font-bold ${theme.border} ${theme.textMuted}`}
            >
                {player.seatNumber}
            </span>

            <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-1.5`}>
                    <span className={`truncate text-sm font-semibold ${theme.text}`}>
                        {player.displayName}
                    </span>
                    {isHostSeat && (
                        <span className="rounded border border-indigo-500/50 bg-indigo-500/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-indigo-300">
                            Host
                        </span>
                    )}
                    {isSelf && (
                        <span
                            className={`rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${theme.accentBorder} ${theme.accentSoft} ${theme.accent}`}
                        >
                            You
                        </span>
                    )}
                </span>
                <span className={`mt-0.5 block text-[11px] ${theme.textFaint}`}>
                    Seat {player.seatNumber}
                </span>
            </span>

            <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                    isReady
                        ? `border-emerald-500/60 bg-emerald-500/15 ${theme.isLight ? 'text-emerald-700' : 'text-emerald-300'}`
                        : `${theme.border} ${theme.textFaint}`
                }`}
            >
                <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${isReady ? 'bg-emerald-500' : 'bg-current'}`}
                />
                {isReady ? 'Ready' : 'Not ready'}
            </span>
        </li>
    )
}

function Spinner() {
    return (
        <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
    )
}
