'use client'

import { useState, useEffect, useRef } from 'react'
import type { PhaseTheme } from '@/lib/game/phase-theme'
import type { SafeRoom } from '@/lib/game/safe-room'

export interface ChatMessage {
    id: string
    round_number: number
    author_player_id: string
    author_name?: string
    message: string
    created_at: string
}

export interface RoomChatPanelProps {
    theme: PhaseTheme
    room: SafeRoom
    isSelfAlive: boolean
    isNight: boolean
    active?: boolean
}

/**
 * Interactive room chat box for village discussion during day/voting phases.
 * When `active` is false, it maintains the static preview matching test scaffolding.
 */
export function RoomChatPanel({ theme, room, isSelfAlive, isNight, active = false }: RoomChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [draft, setDraft] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    const unavailableReason = !isSelfAlive
        ? 'Eliminated players cannot use room chat.'
        : isNight
          ? 'Chat opens during the day. The village must not read your messages before the night.'
          : null

    const canSend = active && isSelfAlive && !isNight && !sending && draft.trim().length > 0

    // Fetch messages periodically or on phase change when active
    useEffect(() => {
        if (!active || room.status !== 'in_progress') return

        let mounted = true
        async function fetchMessages() {
            try {
                const res = await fetch(`/api/rooms/${room.id}/chat`)
                if (!res.ok) return
                const data = await res.json()
                if (mounted && Array.isArray(data.messages)) {
                    setMessages(data.messages)
                }
            } catch {
                // Ignore transient network errors
            }
        }

        fetchMessages()
        const interval = setInterval(fetchMessages, 4000)
        return () => {
            mounted = false
            clearInterval(interval)
        }
    }, [active, room.id, room.status, room.phase])

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages.length])

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!canSend) return

        const msg = draft.trim()
        setDraft('')
        setSending(true)
        setError(null)

        try {
            const res = await fetch(`/api/rooms/${room.id}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg }),
            })
            if (!res.ok) {
                const data = await res.json()
                setError(data?.error?.message || 'Gagal mengirim pesan.')
            } else {
                const data = await res.json()
                if (data?.message) {
                    setMessages((prev) => [...prev, data.message])
                }
            }
        } catch {
            setError('Koneksi terputus.')
        } finally {
            setSending(false)
        }
    }

    const playerMap = new Map(room.players.map((p) => [p.id, p.displayName]))

    if (!active) {
        return (
            <aside
                aria-label="Room chat"
                className={`flex h-full flex-col rounded-2xl border p-3 shadow-xl sm:p-4 ${theme.surface}`}
            >
                <div
                    className={`flex items-baseline justify-between gap-2 border-b pb-2.5 ${theme.divider}`}
                >
                    <h2 className={`text-[11px] font-bold uppercase tracking-[0.18em] ${theme.text}`}>
                        Room Chat
                    </h2>
                    <span
                        className={`text-[10px] font-medium uppercase tracking-wider ${theme.textFaint}`}
                    >
                        Coming soon
                    </span>
                </div>

                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
                    <span aria-hidden="true" className={`text-2xl ${theme.textFaint}`}>
                        💬
                    </span>
                    <p className={`text-xs ${theme.textMuted}`}>
                        {unavailableReason ?? 'Room chat is being prepared for this game.'}
                    </p>
                    <p className={`text-[11px] ${theme.textFaint}`}>
                        Players in this room: {room.players.length}
                    </p>
                </div>

                <div
                    className={`rounded-lg border border-dashed px-3 py-2 text-center text-[11px] ${theme.surfaceRaised} ${theme.textFaint}`}
                >
                    Message box is not active yet.
                </div>
            </aside>
        )
    }

    return (
        <aside
            aria-label="Room chat"
            className={`flex flex-col rounded-2xl border p-3 shadow-xl sm:p-4 ${theme.surface}`}
        >
            <div
                className={`flex items-baseline justify-between gap-2 border-b pb-2.5 ${theme.divider}`}
            >
                <div className="flex items-center gap-2">
                    <span aria-hidden="true" className="text-base">💬</span>
                    <h2 className={`text-[11px] font-bold uppercase tracking-[0.18em] ${theme.text}`}>
                        Room Chat
                    </h2>
                </div>
                <span className={`text-[10px] font-mono font-medium ${isNight ? 'text-indigo-300' : 'text-emerald-400'}`}>
                    {isNight ? 'Malam (Tutup)' : 'Siang (Aktif)'}
                </span>
            </div>

            <div
                ref={scrollRef}
                className="my-3 flex flex-col gap-2 overflow-y-auto text-left min-h-[140px] max-h-[320px] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
                {unavailableReason && messages.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
                        <span aria-hidden="true" className="text-2xl opacity-40">🔒</span>
                        <p className={`mt-2 text-xs ${theme.textMuted}`}>{unavailableReason}</p>
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
                        <span aria-hidden="true" className="text-2xl opacity-40">🗯️</span>
                        <p className={`mt-2 text-xs ${theme.textMuted}`}>Belum ada percakapan. Mulai musyawarah!</p>
                    </div>
                ) : (
                    messages.map((m) => {
                        const author = m.author_name || playerMap.get(m.author_player_id) || 'Warga'
                        return (
                            <div
                                key={m.id}
                                className={`rounded-xl border px-3 py-1.5 ${theme.surfaceRaised} ${theme.border}`}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-bold text-amber-400">
                                        {author}
                                    </span>
                                    <span className={`text-[9px] font-mono ${theme.textFaint}`}>
                                        R{m.round_number}
                                    </span>
                                </div>
                                <p className={`mt-0.5 text-xs leading-normal ${theme.text}`}>
                                    {m.message}
                                </p>
                            </div>
                        )
                    })
                )}
            </div>

            {error && (
                <p className="mb-2 text-center text-[11px] text-red-400">{error}</p>
            )}

            <form onSubmit={handleSend} className="flex gap-2">
                <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={!isSelfAlive || isNight || sending}
                    placeholder={
                        !isSelfAlive
                            ? 'Orang mati tidak bisa bicara...'
                            : isNight
                            ? 'Chat dibuka saat siang hari...'
                            : 'Ketik pesan musyawarah...'
                    }
                    maxLength={500}
                    className={`flex-1 rounded-xl border px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50 ${theme.surfaceRaised} ${theme.border} ${theme.text}`}
                />
                <button
                    type="submit"
                    disabled={!canSend}
                    className="rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-bold text-black transition hover:bg-amber-400 disabled:opacity-40"
                >
                    Kirim
                </button>
            </form>
        </aside>
    )
}
