'use client'

import { useEffect, useState, useCallback, useReducer, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { GameOverPanel } from '@/components/game/GameOverPanel'
import { LobbyPanel } from '@/components/game/LobbyPanel'
import { PlayerRoster } from '@/components/game/PlayerRoster'
import { RoomChatPanel } from '@/components/game/RoomChatPanel'
import { PhaseShell } from '@/components/game/PhaseShell'
import {
    PhaseAnnouncementLiveRegion,
    PhaseAnnouncementOverlay,
} from '@/components/game/PhaseAnnouncement'
import { SecretRoleCard } from '@/components/game/SecretRoleCard'
import { ToastViewport, useToasts } from '@/components/game/Toast'
import { nightActionToast, voteCastToast } from '@/lib/game/action-messages'
import { SETTINGS } from '@/lib/game/settings'
import {
    NEUTRAL_THEME_TOKENS,
    resolveGameOverPresentation,
    resolvePhaseTheme,
    resolvePhaseThemeKey,
} from '@/lib/game/phase-theme'
import {
    announcementDurationMs,
    initialPhaseTransitionState,
    phaseTransitionReducer,
} from '@/lib/game/phase-transition'
import { canStartLobbyGame, isSameUser, roomSurface, type SafeRoom } from '@/lib/game/safe-room'
import {
    clearAllCaches,
    fetchMyRoleSnapshot,
    fetchRoomSnapshot,
    invalidateRoom,
    invalidateRolesForRoom,
} from '@/lib/game/room-cache'
import {
    hasSecretRole,
    initialSecretRoleCardState,
    isSecretRoleCurrent,
    secretRoleCardReducer,
    secretRoleScope,
} from '@/lib/game/secret-role-card'

export default function LobbyPage() {
    const params = useParams()
    const roomId = params?.roomId as string
    const { user, loading: authLoading, supabase } = useAuth()

    const [room, setRoom] = useState<SafeRoom | null>(null)
    // Mirrors `room` so the fetch path can compare against the PREVIOUS snapshot
    // without reading stale closure state, and without adding `room` to the
    // callback's dependency list (which would recreate it every poll).
    const roomRef = useRef<SafeRoom | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [secretRole, dispatchSecretRole] = useReducer(
        secretRoleCardReducer,
        initialSecretRoleCardState
    )
    const [phaseTransition, dispatchPhaseTransition] = useReducer(
        phaseTransitionReducer,
        initialPhaseTransitionState
    )
    // The caller's night action, tagged with the round it belongs to. Tagging it
    // is what makes the lock expire on its own when the round advances, without
    // an effect that would setState during render.
    const [myNightAction, setMyNightAction] = useState<{
        round: number | null
        targetPlayerId: string | null
    } | null>(null)
    const [myVoteTargetId, setMyVoteTargetId] = useState<string | null>(null)
    const toasts = useToasts()
    const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null)
    const [realtimeStatus, setRealtimeStatus] = useState<
        'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'CHANNEL_ERROR'
    >('CONNECTING')

    // `room` state survives client-side navigation between rooms, so the secret is
    // only considered current when it was loaded for the room being displayed.
    // This also prevents a stale role from flashing while a new room loads.
    const activeRoleScope = room?.id === roomId ? secretRoleScope(room.id, room.createdAt) : null
    const visibleSecretRole = isSecretRoleCurrent(secretRole, activeRoleScope)
        ? secretRole
        : { ...initialSecretRoleCardState, scope: activeRoleScope }
    const currentRound = room?.id === roomId ? (room.roundNumber ?? null) : null
    const actionForThisRound =
        myNightAction && myNightAction.round === currentRound ? myNightAction : null
    const currentNightTargetId = actionForThisRound?.targetPlayerId ?? null
    // Once an action exists for this round the target buttons must stop offering
    // it: re-submitting would only be rejected by the server.
    const hasActedThisRound = actionForThisRound !== null
    const currentVoteTargetId = room?.id === roomId ? myVoteTargetId : null

    // Plain function, not a useCallback: every caller goes through
    // `fetchRoomRef`, which keeps effect identities stable regardless.
    const fetchRoom = async (opts?: { force?: boolean }) => {
        if (!roomId) return
        try {
            setError(null)
            const result = await fetchRoomSnapshot(roomId, opts)
            if (!result.ok) {
                if (result.status === 401 || result.status === 404) {
                    // Access to this room is gone: drop any cached private role data.
                    dispatchSecretRole({ type: 'access-lost', scope: null })
                    invalidateRoom(roomId)
                }
                if (result.status === 401) {
                    setError('Authentication required. Please sign in on the homepage.')
                } else if (result.status === 404) {
                    setError('Room not found or you are not a member of this room.')
                } else {
                    setError(result.message)
                }
                return
            }

            const data = { room: result.room }
            const nextScope = secretRoleScope(data.room.id, data.room.createdAt)
            // Feed the authoritative phase to the transition machine. It only mints
            // an announcement when the phase actually moves inside this scope, so
            // Realtime bursts, polls and reconnects stay silent.
            dispatchPhaseTransition({
                type: 'observed',
                scope: nextScope,
                key: resolvePhaseThemeKey(data.room.status, data.room.phase),
                roundNumber: data.room.roundNumber ?? 0,
            })

            // A resolved night appends new investigations, so the private role
            // only needs refetching when the authoritative phase/round actually
            // moved — not on every snapshot.
            const prev = roomRef.current
            const phaseMoved =
                !prev ||
                prev.status !== data.room.status ||
                prev.phase !== data.room.phase ||
                prev.roundNumber !== data.room.roundNumber

            setRoom(data.room)
            roomRef.current = data.room
            // The private role is user-scoped, so it is read on demand and only
            // re-fetched when the authoritative phase/round moved (a resolved
            // night appends investigations). Never shared between users.
            if (
                (data.room.status === 'in_progress' || data.room.status === 'finished') &&
                user?.id
            ) {
                if (phaseMoved && prev) {
                    invalidateRolesForRoom(roomId)
                }
                const roleResult = await fetchMyRoleSnapshot(
                    roomId,
                    user.id,
                    phaseMoved && prev ? { force: true } : undefined
                )
                if (roleResult.ok) {
                    dispatchSecretRole({
                        type: 'role-assigned',
                        scope: nextScope,
                        role: {
                            roleKey: roleResult.role.roleKey,
                            alignment: roleResult.role.alignment,
                            investigations: roleResult.role.investigations ?? [],
                        },
                    })
                    setMyNightAction(
                        roleResult.role.nightAction
                            ? {
                                  round: result.room.roundNumber ?? null,
                                  targetPlayerId: roleResult.role.nightAction.targetPlayerId,
                              }
                            : null
                    )
                } else if (
                    roleResult.status === 401 ||
                    roleResult.status === 403 ||
                    roleResult.status === 404
                ) {
                    dispatchSecretRole({ type: 'access-lost', scope: nextScope })
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error loading room.')
        } finally {
            setLoading(false)
        }
    }

    const handleToggleReady = async () => {
        if (!roomId || !room || actionLoading !== null) return
        const myPlayer = room.players.find(
            (p) => user?.id && (p.userId === user.id || p.id === user.id)
        )
        const targetReady = !myPlayer?.isReady

        setActionLoading('ready')
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/ready`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isReady: targetReady }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to update ready state.')
                // Re-sync to restore real state on error
                await fetchRoom({ force: true })
            } else {
                await fetchRoom({ force: true })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error updating ready state.')
            await fetchRoom({ force: true })
        } finally {
            setActionLoading(null)
        }
    }

    const handleStartGame = async () => {
        if (!roomId || !room) return
        setActionLoading('start')
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to start game.')
            } else {
                // fetchRoom detects the lobby -> in_progress transition and
                // force-refetches the private role, so no extra call is needed.
                await fetchRoom({ force: true })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error starting game.')
        } finally {
            setActionLoading(null)
        }
    }

    const handleNightAction = async (
        targetPlayerId: string,
        actionType: 'eliminate' | 'investigate' | 'protect'
    ) => {
        if (!roomId || !room || !targetPlayerId || actionLoading !== null) return
        setActionLoading(`night-${targetPlayerId}`)
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/actions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actionType,
                    targetPlayerId,
                }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to submit night action.')
            } else {
                // Only after the server confirms: the toast must never claim success
                // for an action the server rejected.
                setMyNightAction({ round: room.roundNumber, targetPlayerId })
                const targetPlayer = room.players.find((p) => p.id === targetPlayerId)
                const copy = nightActionToast(actionType, targetPlayer?.displayName ?? 'target')
                toasts.notifySuccess(copy.title, copy.description)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error submitting action.')
        } finally {
            setActionLoading(null)
        }
    }

    const handleCastVote = async (targetPlayerId: string) => {
        if (!roomId || !room || !targetPlayerId || actionLoading !== null) return
        setActionLoading(`vote-${targetPlayerId}`)
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/votes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetPlayerId,
                }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to cast vote.')
            } else {
                setMyVoteTargetId(targetPlayerId)
                const targetPlayer = room.players.find((p) => p.id === targetPlayerId)
                const copy = voteCastToast(targetPlayer?.displayName ?? 'target')
                toasts.notifySuccess(copy.title, copy.description)
                await fetchRoom({ force: true })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error casting vote.')
        } finally {
            setActionLoading(null)
        }
    }

    const handleDevAddBots = async (count: number) => {
        if (!roomId || !room) return
        setActionLoading('dev-bots')
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/dev-add-bots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ count, ready: true }),
            })
            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to add test bots.')
            } else {
                await fetchRoom({ force: true })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error adding bots.')
        } finally {
            setActionLoading(null)
        }
    }
    // Stable handle to the latest fetchRoom. Every effect and callback uses
    // this instead of `fetchRoom` itself, so none of them re-subscribe when the
    // component re-renders.
    const fetchRoomRef = useRef(fetchRoom)
    useEffect(() => {
        fetchRoomRef.current = fetchRoom
    })

    useEffect(() => {
        if (!roomId || authLoading) return
        const timer = window.setTimeout(() => {
            void fetchRoomRef.current()
        }, 0)
        return () => window.clearTimeout(timer)
    }, [roomId, authLoading])

    // Signing out, or switching accounts, must not leave the previous account's
    // role (or membership-scoped snapshot) in the module cache. This runs on
    // unmount as well as on every identity change.
    const userId = user?.id ?? null
    useEffect(() => {
        return () => {
            clearAllCaches()
        }
    }, [userId])

    // Navigating between rooms (the page component is reused) must drop the
    // previous room's cached snapshot so the new room cannot render stale data.
    useEffect(() => {
        roomRef.current = null
        invalidateRoom(roomId)
        return () => {
            roomRef.current = null
        }
    }, [roomId])

    // Supabase Realtime subscription
    // Listens for updates in room_players and rooms filtered by room_id/id.
    // Events invalidate the cache and coalesce into ONE refetch: a lobby join
    // burst used to fire a separate full snapshot request per event.
    // Coalescing scheduler. Realtime events, the deadline trigger and the
    // heartbeat all funnel through here, so simultaneous triggers collapse into
    // a single request rather than racing each other.
    const coalesceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const requestRefresh = useCallback((options?: { force?: boolean; delayMs?: number }) => {
        const delay = options?.delayMs ?? 0
        if (coalesceRef.current !== null) return
        coalesceRef.current = setTimeout(() => {
            coalesceRef.current = null
            void fetchRoomRef.current(options)
        }, delay)
    }, [])
    // Clear a pending refresh when the room changes or the page unmounts, so a
    // stale timer can never fetch a room we have already navigated away from.
    useEffect(() => {
        return () => {
            if (coalesceRef.current !== null) {
                clearTimeout(coalesceRef.current)
                coalesceRef.current = null
            }
        }
    }, [roomId])

    // Phase countdown and automatic lazy advancement trigger.
    // The deadline can now cross only ONCE per phase: previously every 1s tick
    // after expiry issued a snapshot request, and each response replaced `room`,
    // which recreated the interval and started the loop again.
    useEffect(() => {
        if (!room || room.status !== 'in_progress' || !room.phaseEndsAt) {
            return
        }

        const phaseEndsAt = room.phaseEndsAt
        let expiredTriggered = false
        const updateTimer = () => {
            const remainingMs = new Date(phaseEndsAt).getTime() - Date.now()
            const secs = Math.max(0, Math.ceil(remainingMs / 1000))
            setSecondsRemaining(secs)

            // When the deadline passes, trigger lazy advancement exactly once.
            if (secs <= 0 && !expiredTriggered) {
                expiredTriggered = true
                requestRefresh({ force: true })
            }
        }

        updateTimer()
        const interval = setInterval(updateTimer, 1000)
        return () => clearInterval(interval)
    }, [room, requestRefresh])

    // Periodic heartbeat during an in_progress game: the safety net for events
    // Realtime never delivered. It is a fallback, not the primary update path,
    // so it no longer forces a cache bypass on every tick.
    useEffect(() => {
        if (!room || room.status !== 'in_progress') return
        const pollInterval = setInterval(() => {
            requestRefresh()
        }, 15_000)
        return () => clearInterval(pollInterval)
    }, [room, requestRefresh])

    useEffect(() => {
        if (!roomId || !supabase || authLoading) return

        const channel = supabase
            .channel(`lobby:${roomId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_id=eq.${roomId}`,
                },
                () => {
                    requestRefresh()
                }
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'rooms',
                    filter: `id=eq.${roomId}`,
                },
                () => {
                    requestRefresh()
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    setRealtimeStatus('CONNECTED')
                    // Re-sync once on connect/reconnect to recover anything missed.
                    requestRefresh({ force: true })
                } else if (status === 'CHANNEL_ERROR') {
                    setRealtimeStatus('CHANNEL_ERROR')
                } else if (status === 'TIMED_OUT' || status === 'CLOSED') {
                    setRealtimeStatus('DISCONNECTED')
                }
            })

        return () => {
            supabase.removeChannel(channel)
        }
    }, [roomId, supabase, authLoading, requestRefresh])

    // Auto-dismiss the phase announcement. Guarded on the announcement id so a
    // stale timer can never clear a banner that was minted after it.
    const announcementId = phaseTransition.active?.id ?? null
    const announcementDuration = announcementDurationMs(phaseTransition)
    useEffect(() => {
        if (announcementId === null) return
        const timer = window.setTimeout(
            () => dispatchPhaseTransition({ type: 'dismissed', id: announcementId }),
            announcementDuration
        )
        return () => window.clearTimeout(timer)
    }, [announcementId, announcementDuration])

    const copyCode = async () => {
        if (!room?.roomCode) return
        try {
            await navigator.clipboard.writeText(room.roomCode)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // Fallback if clipboard API is blocked
        }
    }

    if (loading && !room) {
        // Rendered with the same neutral tokens the themed shell uses, so the very
        // first paint can never flash the wrong phase palette.
        return (
            <PhaseShell theme={NEUTRAL_THEME_TOKENS} width="wide">
                <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
                    <div
                        aria-hidden="true"
                        className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-500/30 border-t-indigo-500 motion-reduce:animate-none"
                    />
                    <p className="text-sm text-gray-400">Entering the village…</p>
                </div>
            </PhaseShell>
        )
    }

    if (error && !room) {
        return (
            <PhaseShell theme={NEUTRAL_THEME_TOKENS} width="default">
                <div className="mx-auto mt-16 max-w-md rounded-2xl border border-rose-900/60 bg-[#111726] p-8 text-center shadow-2xl">
                    <div
                        aria-hidden="true"
                        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-rose-800 bg-rose-950/80 text-xl font-bold text-rose-400"
                    >
                        ✕
                    </div>
                    <h2 className="mb-2 text-xl font-bold text-white">Unable to join this room</h2>
                    <p className="mb-6 text-sm text-rose-200">{error}</p>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            onClick={() => fetchRoom({ force: true })}
                            className="w-full rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
                        >
                            Retry connection
                        </button>
                        <Link
                            href="/"
                            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-indigo-500"
                        >
                            Back to home
                        </Link>
                    </div>
                </div>
            </PhaseShell>
        )
    }

    const isHost = Boolean(room?.hostUserId && user?.id && room.hostUserId === user.id)

    // The theme follows the authoritative snapshot, never the clock.
    const theme = resolvePhaseTheme(room?.status, room?.phase)
    // Single source of truth for which surface renders. See `roomSurface`: the
    // play layout used to be gated on `!isLobby`, which is also true for
    // `finished`, so a terminated game kept rendering the live board.
    const surface = roomSurface(room?.status)
    const isLobby = surface === 'lobby'
    const isFinished = surface === 'gameOver'
    // 'saat permainan': the three-column play layout (card | roster | chat).
    const isPlaying = surface === 'playing'
    const showRoleCard = hasSecretRole(visibleSecretRole)
    const gameOver = resolveGameOverPresentation(room?.winner)
    const myPlayer = room?.players.find((player) => isSameUser(player, user?.id))
    // Both the roster size and the readiness rule come from the shared predicate,
    // so the Start button can never disagree with the start route or the RPC.
    const canStartGame = room
        ? canStartLobbyGame(room.players, SETTINGS.gameplay.minStartablePlayers)
        : false

    return (
        <PhaseShell theme={theme} width={isLobby ? 'wide' : isPlaying ? 'gameWide' : 'game'}>
            {/* Out of flow: shows action confirmations without pushing the roster. */}
            {toasts.toast && <ToastViewport toast={toasts.toast} onDismiss={toasts.dismiss} />}
            {phaseTransition.active && (
                <>
                    <PhaseAnnouncementLiveRegion announcement={phaseTransition.active} />
                    <PhaseAnnouncementOverlay announcement={phaseTransition.active} />
                </>
            )}
            {/*
        Deliberately NOT keyed by phase. React commits the whole tree's class
        changes in a single pass, so the new palette lands atomically and there
        is no half-styled frame — and keeping this subtree stable means the
        Secret Role Card is never remounted by an unrelated phase or Realtime
        update, so its reveal cannot replay.
      */}
            <div className="flex flex-col gap-3 sm:gap-3.5">
                {/* --- Lobby: spacious, sectioned waiting room --- */}
                {isLobby && room && (
                    <LobbyPanel
                        theme={theme}
                        room={room}
                        isHost={isHost}
                        isSelfReady={myPlayer?.isReady ?? false}
                        canStart={canStartGame}
                        copied={copied}
                        busyKey={actionLoading}
                        currentUserId={user?.id}
                        onCopyCode={copyCode}
                        onToggleReady={handleToggleReady}
                        onStartGame={handleStartGame}
                        onDevAddBots={handleDevAddBots}
                    />
                )}

                {/* --- Game over: faction-specific victory/defeat --- */}
                {isFinished && room && (
                    <GameOverPanel
                        presentation={gameOver}
                        room={room}
                        ownRole={
                            hasSecretRole(visibleSecretRole) ? (
                                <p className={`text-xs ${theme.textMuted}`}>
                                    Your role was{' '}
                                    <strong className={`font-mono uppercase ${theme.accent}`}>
                                        {visibleSecretRole.roleKey}
                                    </strong>{' '}
                                    <span className={theme.textFaint}>
                                        ({visibleSecretRole.alignment})
                                    </span>
                                </p>
                            ) : null
                        }
                    />
                )}

                {/* Play layout: role card (left) | roster, banner and nav (right), with
                    the room chat spanning the full width underneath. Lobby and
                    game-over keep the original single-column stack.

                    Gated on `isPlaying`, NOT `!isLobby`: `finished` satisfies
                    `!isLobby`, so this used to render the full live layout —
                    banner, role card, roster, chat — on top of the GameOverPanel
                    below it. A finished game therefore still looked like a game in
                    progress, which reads as "the game never ended" even though the
                    room had correctly reached `finished`. */}
                {isPlaying && room && (
                    <div
                        className={`grid gap-3 ${
                            isPlaying ? 'lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]' : ''
                        }`}
                    >
                        <div className={isPlaying ? 'lg:col-start-1 lg:row-start-1' : ''}>
                            {/* Secret role card: independent of the phase theme, own role identity */}
                            {showRoleCard && (
                                <SecretRoleCard
                                    roleKey={visibleSecretRole.roleKey}
                                    alignment={visibleSecretRole.alignment}
                                    investigations={visibleSecretRole.investigations}
                                    players={room?.players}
                                    theme={theme}
                                />
                            )}
                        </div>

                        <div
                            className={`flex flex-col gap-3 ${isPlaying ? 'lg:col-start-2 lg:row-start-1' : ''}`}
                        >
                            {/* Phase banner and alerts live in the centre column so the role card
                            and room chat can rise to the top of the layout. */}
                            {/* --- In-game phase banner: the dominant heading during play --- */}
                            {!isLobby && room && (
                                <header
                                    className={`relative overflow-hidden rounded-2xl border px-4 py-3 shadow-xl sm:px-5 sm:py-3.5 ${theme.surface} ${theme.accentGlow}`}
                                >
                                    <div
                                        aria-hidden="true"
                                        className={`pointer-events-none absolute inset-x-0 -top-10 h-24 ${theme.accentSoft} blur-2xl`}
                                    />

                                    <div className="relative flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
                                        <div className="min-w-0">
                                            <p
                                                className={`text-[10px] font-bold uppercase tracking-[0.26em] ${theme.eyebrow}`}
                                            >
                                                {theme.label}
                                                {isFinished ? '' : ' Phase'}
                                            </p>
                                            <h1
                                                className={`mt-1 font-mono text-2xl font-black uppercase leading-none tracking-wider sm:text-3xl ${theme.accent}`}
                                            >
                                                {isFinished ? gameOver.headline : theme.label}
                                            </h1>
                                            {room.status === 'in_progress' && (
                                                <p className={`mt-1.5 text-xs ${theme.textMuted}`}>
                                                    Round{' '}
                                                    <span className="font-mono font-bold">
                                                        {room.roundNumber}
                                                    </span>{' '}
                                                    ·{' '}
                                                    {room.phase === 'night'
                                                        ? 'Choose who the pack strikes.'
                                                        : room.phase === 'voting'
                                                          ? 'Choose who the village suspects.'
                                                          : 'Discuss, then be ready to vote.'}
                                                </p>
                                            )}
                                        </div>

                                        {room.status === 'in_progress' &&
                                            secondsRemaining !== null && (
                                                <div className="text-right">
                                                    <p
                                                        className={`text-[10px] font-bold uppercase tracking-[0.2em] ${theme.eyebrow}`}
                                                    >
                                                        Time left
                                                    </p>
                                                    <p
                                                        className={`mt-0.5 font-mono text-3xl font-black tabular-nums leading-none sm:text-4xl ${
                                                            secondsRemaining <= 10
                                                                ? theme.accent
                                                                : theme.text
                                                        }`}
                                                    >
                                                        {secondsRemaining}s
                                                    </p>
                                                </div>
                                            )}
                                    </div>
                                </header>
                            )}

                            {/* --- Alerts --- */}
                            {error && (
                                <div
                                    role="alert"
                                    className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/60 bg-rose-950/80 px-3.5 py-2.5 text-xs text-rose-100 shadow"
                                >
                                    <span className="flex items-center gap-2">
                                        <span
                                            aria-hidden="true"
                                            className="font-bold text-rose-300"
                                        >
                                            ✕
                                        </span>
                                        {error}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setError(null)}
                                        aria-label="Dismiss error"
                                        className="rounded p-1 text-rose-300 transition hover:text-white"
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
                            {/* Nav travels with the middle section, per the three-column layout. */}
                            {/* --- Utility bar: navigation, room code, connection --- */}
                            <div
                                className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 shadow-lg ${theme.surface}`}
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <Link
                                        href="/"
                                        className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${theme.buttonNeutral}`}
                                    >
                                        ← Home
                                    </Link>
                                    {/* <div className="flex min-w-0 items-baseline gap-2">
                                <span
                                    className={`text-[10px] font-bold uppercase tracking-[0.18em] ${theme.eyebrow}`}
                                >
                                    Room
                                </span>
                                <span
                                    className={`truncate font-mono text-base font-black tracking-[0.16em] ${theme.accent}`}
                                >
                                    {room?.roomCode}
                                </span>
                                <button
                                    type="button"
                                    onClick={copyCode}
                                    aria-label={`Copy room code ${room?.roomCode ?? ''}`}
                                    className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${theme.buttonNeutral}`}
                                >
                                    {copied ? '✓' : 'Copy'}
                                </button>
                            </div> */}
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {isLobby && (
                                        <span
                                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider ${theme.statusPill}`}
                                        >
                                            <span aria-hidden="true">{theme.glyph}</span>
                                            {theme.label}
                                        </span>
                                    )}

                                    {/* <span
                                title={`Connection: ${realtimeStatus}`}
                                className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${theme.textFaint}`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`h-2 w-2 rounded-full ${
                                        realtimeStatus === 'CONNECTED'
                                            ? 'bg-emerald-400'
                                            : realtimeStatus === 'CONNECTING'
                                              ? 'bg-amber-400 animate-pulse motion-reduce:animate-none'
                                              : 'bg-rose-400'
                                    }`}
                                />
                                <span className="hidden sm:inline">{realtimeStatus.toLowerCase()}</span>
                            </span> */}

                                    {/* <button
                                type="button"
                                onClick={() => fetchRoom({ force: true })}
                                disabled={loading}
                                aria-label="Refresh room"
                                title="Refresh Room"
                                className={`rounded-lg border px-2 py-1 text-xs transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${theme.buttonNeutral}`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={loading ? 'animate-spin motion-reduce:animate-none' : ''}
                                >
                                    ↻
                                </span>
                            </button> */}
                                </div>
                            </div>

                            {/* --- In-game roster: single column, living first --- */}
                            <PlayerRoster
                                room={room}
                                theme={theme}
                                userId={user?.id}
                                myPlayer={myPlayer}
                                myRoleKey={visibleSecretRole.roleKey}
                                myNightTargetId={currentNightTargetId}
                                hasActedThisRound={hasActedThisRound}
                                myVoteTargetId={currentVoteTargetId}
                                actionLoading={actionLoading}
                                onNightAction={handleNightAction}
                                onCastVote={handleCastVote}
                            />
                        </div>

                        <div className={isPlaying ? 'lg:col-start-1 lg:row-start-2' : ''} />

                        {isPlaying && (
                            <div className="lg:col-start-2 lg:row-start-2">
                                <RoomChatPanel
                                    theme={theme}
                                    room={room}
                                    isSelfAlive={myPlayer?.isAlive ?? false}
                                    isNight={room.phase === 'night'}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </PhaseShell>
    )
}
