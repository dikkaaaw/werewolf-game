'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { roomEntryAvailability } from '@/lib/game/room-entry'

function HomeContent() {
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()

    const [displayName, setDisplayName] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('ww_nickname') ?? ''
        }
        return ''
    })
    const [pin, setPin] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('ww_pin') ?? ''
        }
        return ''
    })
    const [roomCode, setRoomCode] = useState(() => {
        return (searchParams.get('code') ?? '').trim().toUpperCase()
    })
    const [error, setError] = useState<string | null>(null)
    const [actionLoading, setActionLoading] = useState<'create' | 'join' | null>(null)

    // Create and join are mutually exclusive: typing a room code means the
    // player is joining, so Create must not stay live alongside it.
    const entry = roomEntryAvailability(displayName, roomCode, actionLoading !== null)
    const isJoining = roomCode.trim().length > 0

    const validateName = (name: string): string | null => {
        const trimmed = name.trim()
        if (trimmed.length < 2) return 'Display name must be at least 2 characters.'
        if (trimmed.length > 24) return 'Display name must be at most 24 characters.'
        if (/[<>]/.test(trimmed)) return 'Display name cannot contain < or >.'
        return null
    }

    const validatePin = (p: string): string | null => {
        const trimmed = p.trim()
        if (trimmed.length < 8) return 'PIN / Passphrase minimal 8 karakter alfanumerik.'
        if (trimmed.length > 64) return 'PIN / Passphrase terlalu panjang (maks 64 karakter).'
        return null
    }

    const validateCode = (code: string): string | null => {
        const trimmed = code.trim().toUpperCase()
        if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
            return 'Room code must be exactly 6 letters/numbers.'
        }
        return null
    }

    const authenticatePlayer = async (): Promise<boolean> => {
        const authRes = await fetch('/api/auth/nickname-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nickname: displayName.trim(),
                pin: pin.trim(),
            }),
        })

        const authData = await authRes.json().catch(() => null)
        if (!authRes.ok) {
            setError(authData?.error?.message ?? 'Failed to authenticate player.')
            return false
        }

        if (typeof window !== 'undefined') {
            localStorage.setItem('ww_nickname', displayName.trim())
            localStorage.setItem('ww_pin', pin.trim())
        }
        return true
    }

    const handleCreateRoom = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        const nameError = validateName(displayName)
        if (nameError) {
            setError(nameError)
            return
        }

        const pinError = validatePin(pin)
        if (pinError) {
            setError(pinError)
            return
        }

        setActionLoading('create')
        try {
            const authOk = await authenticatePlayer()
            if (!authOk) return

            const res = await fetch('/api/rooms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName: displayName.trim(),
                    maxPlayers: 10,
                }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to create room.')
                return
            }

            if (data.roomId) {
                router.push(`/rooms/${data.roomId}`)
            } else {
                setError('Room created but no room ID was returned.')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error creating room.')
        } finally {
            setActionLoading(null)
        }
    }

    const handleJoinRoom = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        const nameError = validateName(displayName)
        if (nameError) {
            setError(nameError)
            return
        }

        const pinError = validatePin(pin)
        if (pinError) {
            setError(pinError)
            return
        }

        const codeError = validateCode(roomCode)
        if (codeError) {
            setError(codeError)
            return
        }

        setActionLoading('join')
        try {
            const authOk = await authenticatePlayer()
            if (!authOk) return

            const res = await fetch('/api/rooms/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomCode: roomCode.trim().toUpperCase(),
                    displayName: displayName.trim(),
                }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error?.message ?? 'Failed to join room.')
                return
            }

            if (data.roomId) {
                router.push(`/rooms/${data.roomId}`)
            } else {
                setError('Joined room but room ID was not returned.')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error joining room.')
        } finally {
            setActionLoading(null)
        }
    }

    return (
        <main className="min-h-screen bg-[#090d16] text-gray-100 flex flex-col items-center justify-center p-4 sm:p-6">
            <div className="w-full max-w-md">
                {/* Game Header */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/80 border border-indigo-800 text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-3">
                        🐺 Phase 2 Lobby
                    </div>
                    <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white mb-2 font-mono">
                        WEREWOLF
                    </h1>
                    <p className="text-gray-400 text-sm max-w-xs mx-auto">
                        Roles are secret. Nights are silent. Votes are open.
                    </p>

                    {/* Auth indicator */}
                    <div className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-400">
                        {authLoading ? (
                            <span className="flex items-center gap-1.5 text-gray-400">
                                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                                Memeriksa sesi...
                            </span>
                        ) : user ? (
                            <span className="flex items-center gap-1.5 text-emerald-400 bg-emerald-950/40 px-2.5 py-1 rounded border border-emerald-900">
                                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                                Nickname & PIN session active
                            </span>
                        ) : null}
                    </div>
                </div>

                {/* Action Card */}
                <div className="bg-[#111726] border border-[#1e293b] rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur">
                    {error && (
                        <div className="mb-6 p-3.5 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm flex items-start gap-2.5">
                            <span className="text-rose-400 font-bold">✕</span>
                            <p className="flex-1">{error}</p>
                        </div>
                    )}

                    {/* Display Name Input (Shared) */}
                    <div className="mb-4">
                        <label
                            htmlFor="displayName"
                            className="block text-sm font-semibold text-gray-300 mb-2"
                        >
                            Your Display Name / Nickname
                        </label>
                        <input
                            id="displayName"
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="e.g. Detective Holmes"
                            maxLength={24}
                            disabled={actionLoading !== null}
                            className="w-full bg-[#0b0f19] border border-gray-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-4 py-3 text-white placeholder-gray-500 text-sm outline-none transition disabled:opacity-50"
                        />
                    </div>

                    {/* Secret PIN / Passphrase Input (Auth Opsi A: Sesi Persisten) */}
                    <div className="mb-6">
                        <label
                            htmlFor="playerPin"
                            className="block text-sm font-semibold text-gray-300 mb-2"
                        >
                            PIN / Passphrase (min. 8 karakter)
                        </label>
                        <input
                            id="playerPin"
                            type="password"
                            value={pin}
                            onChange={(e) => setPin(e.target.value)}
                            placeholder="e.g. secret123 / hunter wolf red"
                            maxLength={64}
                            disabled={actionLoading !== null}
                            className="w-full bg-[#0b0f19] border border-gray-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-4 py-3 text-white placeholder-gray-500 text-sm outline-none transition disabled:opacity-50 tracking-widest font-mono"
                        />
                        <p className="mt-1.5 text-xs text-gray-500">
                            Digunakan untuk mengunci & mereclaim kursimu bila browser ditutup atau berganti device.
                        </p>
                    </div>

                    {/* Create Room Section */}
                    <div className="mb-6">
                        <button
                            type="button"
                            onClick={handleCreateRoom}
                            disabled={!entry.canCreate}
                            className="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold py-3 px-4 rounded-lg transition shadow-lg shadow-indigo-950 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {actionLoading === 'create' ? (
                                <>
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Creating Room...
                                </>
                            ) : (
                                'Create New Room'
                            )}
                        </button>
                        {isJoining && (
                            <p className="mt-2 text-xs text-amber-500/80">
                                Remove the room code to create a new room instead.
                            </p>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="relative my-6 flex items-center justify-center">
                        <div className="border-t border-gray-800 w-full" />
                        <span className="bg-[#111726] px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider absolute">
                            or join room
                        </span>
                    </div>

                    {/* Join Room Section */}
                    <form onSubmit={handleJoinRoom} className="space-y-4">
                        <div>
                            <label
                                htmlFor="roomCode"
                                className="block text-sm font-semibold text-gray-300 mb-2"
                            >
                                Room Code (6 Characters)
                            </label>
                            <input
                                id="roomCode"
                                type="text"
                                value={roomCode}
                                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                                placeholder="ABCDEF"
                                maxLength={6}
                                disabled={actionLoading !== null}
                                className="w-full bg-[#0b0f19] border border-gray-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg px-4 py-3 text-amber-300 font-mono text-center tracking-widest text-lg uppercase placeholder-gray-600 outline-none transition disabled:opacity-50"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={!entry.canJoin}
                            className="w-full bg-slate-800 hover:bg-slate-700 active:bg-slate-850 border border-slate-700 text-slate-100 font-semibold py-3 px-4 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {actionLoading === 'join' ? (
                                <>
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Joining Room...
                                </>
                            ) : (
                                'Join With Code'
                            )}
                        </button>
                    </form>
                </div>
            </div>
        </main>
    )
}

function HomeFallback() {
    return (
        <main className="min-h-screen bg-[#090d16] text-gray-100 flex flex-col items-center justify-center p-4 sm:p-6">
            <div className="w-full max-w-md text-center">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/80 border border-indigo-800 text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-3">
                    🐺 Phase 2 Lobby
                </div>
                <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white mb-2 font-mono">
                    WEREWOLF
                </h1>
                <p className="text-gray-400 text-sm max-w-xs mx-auto mb-8">
                    Roles are secret. Nights are silent. Votes are open.
                </p>
                <div className="bg-[#111726] border border-[#1e293b] rounded-2xl p-6 sm:p-8 shadow-2xl h-96 flex items-center justify-center">
                    <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
                </div>
            </div>
        </main>
    )
}

export default function HomePage() {
    return (
        <Suspense fallback={<HomeFallback />}>
            <HomeContent />
        </Suspense>
    )
}
