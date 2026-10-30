'use client'

import { useEffect, useState, useCallback, useReducer, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { GameOverPanel } from '@/components/game/GameOverPanel'
import { LobbyPanel } from '@/components/game/LobbyPanel'
import { PlayerRoster } from '@/components/game/PlayerRoster'
import { RoomChatPanel } from '@/components/game/RoomChatPanel'
import { VillageTimeline } from '@/components/game/VillageTimeline'
import { PhaseShell } from '@/components/game/PhaseShell'
import {
    PhaseAnnouncementLiveRegion,
    PhaseAnnouncementOverlay,
} from '@/components/game/PhaseAnnouncement'
import { SecretRoleCard } from '@/components/game/SecretRoleCard'
import { HunterShotPrompt } from '@/components/game/HunterShotPrompt'
import { PhaseCountdown } from '@/components/game/PhaseCountdown'
import type { SettingsPayload } from '@/components/game/LobbySettings'
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
    const [hunterAction, setHunterAction] = useState<{ deadlineAt: string; targets: Array<{ id: string; displayName: string }> } | null>(null)
    const [myNightAction, setMyNightAction] = useState<{
        round: number | null
        targetPlayerId: string | null
    } | null>(null)
    const [myVoteTargetId, setMyVoteTargetId] = useState<string | null>(null)
    const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set())
    const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
    const [realtimeStatus, setRealtimeStatus] = useState<string>('DISCONNECTED')
    const toasts = useToasts()
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
        // Captured so every post-await guard below compares against the room this
        // call was issued for, not whatever `roomId` holds once the response
        // lands. Navigating between rooms reuses this component, so a late
        // response from the previous room used to be applied to the new one.
        const requestedRoomId = roomId
        try {
            setError(null)
            const result = await fetchRoomSnapshot(requestedRoomId, opts)
            // The user may have navigated away, signed out, or the cache may have
            // been invalidated while this request was in flight. Applying it now
            // would overwrite newer state with a stale snapshot.
            if (requestedRoomId !== roomId) return
            if (!result.ok) {
                if (result.status === 401 || result.status === 404) {
                    // Access to this room is gone: drop any cached private role data.
                    dispatchSecretRole({ type: 'access-lost', scope: null })
                    invalidateRoom(requestedRoomId)
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

            // Out-of-order guard. `state_version` is bumped by the database on
            // every mutation, so a snapshot carrying a LOWER version than the one
            // already on screen is one that was issued earlier and resolved later
            // — applying it would roll the UI backwards. Equal versions are
            // allowed: a settings read-back and a realtime event can both describe
            // the same commit.
            if (prev && prev.id === data.room.id && data.room.stateVersion < prev.stateVersion) {
                return
            }

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
                    setHunterAction(roleResult.role.hunterAction ?? null)
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

    const broadcastUpdate = useCallback((reason: string) => {
        if (channelRef.current) {
            channelRef.current.send({
                type: 'broadcast',
                event: 'room_updated',
                payload: { reason, timestamp: Date.now() },
            })
        }
    }, [])

    const [hunterSubmitting, setHunterSubmitting] = useState(false)
    const handleHunterShot = async (targetPlayerId: string) => {
        if (!roomId || hunterSubmitting) return
        setHunterSubmitting(true)
        try {
            const res = await fetch(`/api/rooms/${roomId}/hunter-shoot`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetPlayerId }),
            })
            invalidateRolesForRoom(roomId)
            if (!res.ok) {
                const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
                toasts.notifyError('Hunter shot failed', body?.error?.message ?? 'Please try again.')
                await fetchRoom({ force: true })
                return
            }
            toasts.notifySuccess('Hunter shot fired', 'The target was eliminated.')
            await fetchRoom({ force: true })
            broadcastUpdate('hunter_shot')
        } catch {
            toasts.notifyError('Hunter shot failed', 'Network error. Please try again.')
        } finally {
            setHunterSubmitting(false)
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
        // Optimistic UI update: toggle ready state immediately
        setRoom((prev) => {
            if (!prev) return prev
            return {
                ...prev,
                players: prev.players.map((p) =>
                    p.id === myPlayer?.id ? { ...p, isReady: targetReady } : p
                ),
            }
        })

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
                broadcastUpdate('ready')
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
                broadcastUpdate('start_game')
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
                // Re-sync so the roster reflects the authoritative state after a
                // rejected (or stale) action rather than staying on the intended one.
                await fetchRoom({ force: true })
            } else {
                // Only after the server confirms: the toast must never claim success
                // for an action the server rejected.
                setMyNightAction({ round: data.roundNumber ?? room.roundNumber, targetPlayerId })
                const targetPlayer = room.players.find((p) => p.id === targetPlayerId)
                const copy = nightActionToast(actionType, targetPlayer?.displayName ?? 'target')
                toasts.notifySuccess(copy.title, copy.description)
                // The server now holds this action; invalidate the private-role
                // cache so the post-mutation refresh re-reads it rather than
                // clobbering myNightAction with a stale null entry.
                invalidateRolesForRoom(roomId)
                // Mirror vote handling: force a fresh snapshot so the authoritative
                // room/vote state and realtime listeners agree with the local lock.
                await fetchRoom({ force: true })
                // Explicitly re-read the private role so myNightAction is synced
                // to the authoritative post-mutation state even if fetchRoom's
                // phase check considered the room unchanged.
                if (user?.id) {
                    const roleRes = await fetchMyRoleSnapshot(roomId, user.id, { force: true })
                    if (roleRes.ok) {
                        setMyNightAction(
                            roleRes.role.nightAction
                                ? {
                                      round: data.roundNumber ?? room.roundNumber ?? null,
                                      targetPlayerId: roleRes.role.nightAction.targetPlayerId,
                                  }
                                : null
                        )
                    }
                }
                broadcastUpdate('night_action')
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
                broadcastUpdate('vote')
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
                broadcastUpdate('dev_bots')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error adding bots.')
        } finally {
            setActionLoading(null)
        }
    }

    /**
     * Save the host's lobby settings (phase durations + role composition).
     *
     * No optimistic update: the server is the only thing that knows whether the
     * payload passed validation and the rooms row lock, so the panel keeps the
     * host's draft and adopts the authoritative values from the forced refresh
     * that follows a confirmed 200. On failure the draft is left untouched so
     * the host can correct it rather than losing their input.
     */
    const handleSaveSettings = async (payload: SettingsPayload) => {
        if (!roomId || actionLoading !== null) return
        setActionLoading('settings')
        setError(null)
        try {
            const res = await fetch(`/api/rooms/${roomId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to save game settings.')
                // Re-sync so the panel shows the configuration the room actually
                // has, rather than the draft that was just rejected.
                await fetchRoom({ force: true })
            } else {
                toasts.notifySuccess('Settings saved', 'Everyone in the lobby will see them.')
                await fetchRoom({ force: true })
                broadcastUpdate('settings')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error saving settings.')
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
        void fetchRoomRef.current()
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
    // Tracks whether the PENDING coalesced request must bypass the cache. A
    // plain refresh followed by a forced one used to be collapsed into the
    // plain one, silently discarding the "hit the server now" intent — which is
    // exactly what the countdown-expiry and reconnect paths rely on.
    const coalesceForceRef = useRef(false)
    const requestRefresh = useCallback((options?: { force?: boolean; delayMs?: number }) => {
        const force = options?.force === true
        if (coalesceRef.current !== null) {
            // Upgrade the pending request rather than dropping the force flag.
            if (force) coalesceForceRef.current = true
            return
        }
        coalesceForceRef.current = force
        coalesceRef.current = setTimeout(() => {
            coalesceRef.current = null
            const pendingForce = coalesceForceRef.current
            coalesceForceRef.current = false
            void fetchRoomRef.current(pendingForce ? { force: true } : undefined)
        }, options?.delayMs ?? 0)
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

    // The countdown itself now lives in <PhaseCountdown />, which owns the 1s
    // tick. Keeping it here re-rendered the entire room tree every second for a
    // value that only ever appears in one label. The one-shot expiry trigger is
    // passed down as `onExpired` and still funnels through the coalescer.
    const handlePhaseExpired = useCallback(() => {
        requestRefresh({ force: true })
    }, [requestRefresh])

    // Periodic heartbeat during an in_progress game: the safety net for events
    // Realtime never delivered. It is a fallback, not the primary update path,
    // so it no longer forces a cache bypass on every tick.
    //
    // Deps are primitives on purpose. Depending on `room` recreated the interval
    // on every snapshot — and since a snapshot arrives on every Realtime event,
    // update traffic faster than 15s starved the heartbeat entirely, removing the
    // safety net precisely when the room was most active.
    const isPlayingNow = room?.status === 'in_progress'
    useEffect(() => {
        if (!isPlayingNow) return
        const pollInterval = setInterval(() => {
            requestRefresh()
        }, 15_000)
        return () => clearInterval(pollInterval)
    }, [isPlayingNow, requestRefresh])

    useEffect(() => {
        if (!roomId || !supabase || authLoading) return

        const channel = supabase
            .channel(`room:${roomId}`, {
                config: {
                    presence: {
                        key: user?.id ?? undefined,
                    },
                },
            })
            .on('broadcast', { event: 'room_updated' }, () => {
                requestRefresh({ force: true })
            })
            .on('presence', { event: 'sync' }, () => {
                const state = channel.presenceState()
                const ids = new Set<string>()
                for (const presences of Object.values(state)) {
                    for (const p of presences as Array<{ userId?: string }>) {
                        if (p.userId) ids.add(p.userId)
                    }
                }
                setOnlineUsers(ids)
            })
            .subscribe(async (status) => {
                setRealtimeStatus(status)
                if (status === 'SUBSCRIBED') {
                    if (user?.id) {
                        await channel.track({
                            userId: user.id,
                            onlineAt: new Date().toISOString(),
                        })
                    }
                    // Notify other peers so they refresh immediately when a peer joins
                    channel.send({
                        type: 'broadcast',
                        event: 'room_updated',
                        payload: { reason: 'presence_joined', timestamp: Date.now() },
                    })
                    requestRefresh({ force: true })
                }
            })

        channelRef.current = channel

        return () => {
            channelRef.current = null
            supabase.removeChannel(channel)
        }
    }, [roomId, supabase, authLoading, user?.id, requestRefresh])

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

    // Guarded so a double-click, or an unmount while the timer is live, cannot
    // leave a stray setState behind. The timer id is tracked rather than left
    // dangling, which is what every other timer in this file already does.
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => {
        return () => {
            if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
        }
    }, [])
    const copyCode = async () => {
        if (!room?.roomCode) return
        try {
            await navigator.clipboard.writeText(room.roomCode)
            setCopied(true)
            if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = setTimeout(() => {
                copiedTimerRef.current = null
                setCopied(false)
            }, 2000)
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
                        onlineUserIds={onlineUsers}
                        onCopyCode={copyCode}
                        onToggleReady={handleToggleReady}
                        onStartGame={handleStartGame}
                        onDevAddBots={handleDevAddBots}
                        onSaveSettings={handleSaveSettings}
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
                    <div className="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)_20rem]">
                        <div className="flex flex-col gap-3">
                            {/* Secret role card: independent of the phase theme, own role identity */}
                            {hunterAction && visibleSecretRole.roleKey === 'hunter' && (
                                <HunterShotPrompt
                                    targets={hunterAction.targets}
                                    deadlineAt={hunterAction.deadlineAt}
                                    submitting={hunterSubmitting}
                                    onSelect={handleHunterShot}
                                />
                            )}
                            {showRoleCard && (
                                <SecretRoleCard
                                    roleKey={visibleSecretRole.roleKey}
                                    alignment={visibleSecretRole.alignment}
                                    investigations={visibleSecretRole.investigations}
                                    players={room?.players}
                                    theme={theme}
                                />
                            )}
                            <VillageTimeline
                                theme={theme}
                                events={room.events}
                                currentPhase={room.phase}
                            />
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

                                        <PhaseCountdown
                                            phaseEndsAt={room.phaseEndsAt}
                                            active={room.status === 'in_progress'}
                                            theme={theme}
                                            onExpired={handlePhaseExpired}
                                        />
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

                                    <span
                                        title={`Connection: ${realtimeStatus}`}
                                        className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${theme.textFaint}`}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`h-2 w-2 rounded-full ${
                                                realtimeStatus === 'SUBSCRIBED'
                                                    ? 'bg-emerald-400'
                                                    : realtimeStatus === 'CONNECTING'
                                                      ? 'bg-amber-400 animate-pulse motion-reduce:animate-none'
                                                      : 'bg-rose-400'
                                            }`}
                                        />
                                        <span className="hidden sm:inline">{realtimeStatus.toLowerCase()}</span>
                                    </span>

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
                                onlineUserIds={onlineUsers}
                                onNightAction={handleNightAction}
                                onCastVote={handleCastVote}
                            />
                        </div>

                        {/* Col 3: Room Chat */}
                        <div>
                            <RoomChatPanel
                                theme={theme}
                                room={room}
                                isSelfAlive={myPlayer?.isAlive ?? false}
                                isNight={room.phase === 'night'}
                                active={true}
                            />
                        </div>
                    </div>
                )}
            </div>
        </PhaseShell>
    )
}
