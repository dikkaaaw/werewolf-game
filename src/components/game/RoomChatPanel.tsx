import type { PhaseTheme } from '@/lib/game/phase-theme'
import type { SafeRoom } from '@/lib/game/safe-room'

export interface RoomChatPanelProps {
    theme: PhaseTheme
    room: SafeRoom
    isSelfAlive: boolean
    isNight: boolean
}

/**
 * Right-hand column reserved for room chat.
 *
 * SCOPE: this is the prepared shell only — layout, theming and the empty /
 * unavailable states. No messages are fetched or sent, and no network call is
 * made from here.
 *
 * The database side already exists (`game_chat_messages` plus its RLS policies
 * in migrations 0001/0002), but wiring it needs a message API route and a
 * Realtime subscription, which are deliberately not part of this change.
 */
export function RoomChatPanel({ theme, room, isSelfAlive, isNight }: RoomChatPanelProps) {
    const unavailableReason = !isSelfAlive
        ? 'Eliminated players cannot use room chat.'
        : isNight
          ? 'Chat opens during the day. The village must not read your messages before the night.'
          : null

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
