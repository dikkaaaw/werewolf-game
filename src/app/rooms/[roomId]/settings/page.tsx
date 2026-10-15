'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'

import { useAuth } from '@/components/auth/AuthProvider'
import { LobbySettings, type SettingsPayload } from '@/components/game/LobbySettings'
import { PHASE_THEMES } from '@/lib/game/phase-theme'
import { PhaseShell } from '@/components/game/PhaseShell'
import { clearAllCaches, fetchRoomSnapshot, invalidateRoom } from '@/lib/game/room-cache'
import type { SafeRoom } from '@/lib/game/safe-room'

export default function RoomSettingsPage() {
    const params = useParams()
    const router = useRouter()
    const roomId = params?.roomId as string
    const { user, loading: authLoading, supabase } = useAuth()

    const [room, setRoom] = useState<SafeRoom | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const loadRoom = useCallback(async (): Promise<void> => {
        if (!roomId) return
        setLoading(true)
        setError(null)

        const result = await fetchRoomSnapshot(roomId, { force: true })
        if (!result.ok) {
            setError(result.message)
            setRoom(null)
        } else {
            setRoom(result.room)
        }
        setLoading(false)
    }, [roomId])

    useEffect(() => {
        if (!roomId) return
        if (authLoading) return
        if (!user) {
            router.replace('/')
            return
        }

        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadRoom()
    }, [authLoading, user, roomId, loadRoom, router])

    useEffect(() => {
        const id = roomId
        if (!id || !supabase || authLoading || !user) return

        const channel = supabase
            .channel(`settings:${id}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${id}` },
                () => {
                    void fetchRoomSnapshot(id, { force: true }).then((result) => {
                        if (result.ok) setRoom(result.room)
                    })
                },
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${id}` },
                () => {
                    void fetchRoomSnapshot(id, { force: true }).then((result) => {
                        if (result.ok) setRoom(result.room)
                    })
                },
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [roomId, supabase, authLoading, user])

    const isHost = Boolean(user && room && user.id === room.hostUserId)
    const canEdit = isHost && room?.status === 'lobby'

    async function handleSave(payload: SettingsPayload): Promise<void> {
        const response = await fetch(`/api/rooms/${roomId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })

        if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as {
                error?: { message?: string }
            }
            throw new Error(body.error?.message ?? 'Failed to save game settings.')
        }

        invalidateRoom(roomId)
        clearAllCaches()
        await loadRoom()
    }

    if (authLoading || loading) {
        return (
            <PhaseShell theme={PHASE_THEMES.lobby} width="wide">
                <div className="flex flex-col items-center gap-4 py-20">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <p className="text-sm text-gray-400">Loading game settings...</p>
                </div>
            </PhaseShell>
        )
    }

    if (error || !room) {
        return (
            <PhaseShell theme={PHASE_THEMES.lobby} width="wide">
                <div className="mx-auto flex max-w-md flex-col gap-4 py-16 text-center">
                    <h1 className="text-xl font-bold">Game Settings</h1>
                    <p className="text-sm text-gray-400">{error ?? 'Room not found.'}</p>
                    <Link
                        href={roomId ? `/rooms/${roomId}` : '/'}
                        className="mx-auto rounded-lg border px-4 py-2 text-sm"
                    >
                        Back to Lobby
                    </Link>
                </div>
            </PhaseShell>
        )
    }

    return (
        <PhaseShell theme={PHASE_THEMES.lobby} width="wide">
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <Link
                        href={`/rooms/${roomId}`}
                        className="rounded-lg border px-3 py-1.5 text-sm"
                    >
                        ← Back to Lobby
                    </Link>
                    <span className="text-xs text-gray-400">
                        {room.roomCode}
                    </span>
                </div>

                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-bold">Game Settings</h1>
                    {!canEdit && (
                        <p className="text-sm text-gray-400">
                            {room.status !== 'lobby'
                                ? 'Settings are locked because the game has started.'
                                : 'Only the host can edit settings.'}
                        </p>
                    )}
                </div>

                <LobbySettings
                    theme={PHASE_THEMES.lobby}
                    room={room}
                    isHost={canEdit}
                    busyKey={null}
                    onSave={handleSave}
                    defaultExpanded
                />
            </div>
        </PhaseShell>
    )
}

