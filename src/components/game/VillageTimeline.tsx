'use client'

import { useEffect, useRef } from 'react'
import type { PhaseTheme } from '@/lib/game/phase-theme'
import type { SafeEvent } from '@/lib/game/safe-room'

export interface VillageTimelineProps {
  theme: PhaseTheme
  events?: SafeEvent[]
  currentPhase?: string
}

function formatNarrative(event: SafeEvent): { icon: string; title: string; subtitle?: string; badgeColor?: string } {
  const payload = event.publicPayload || {}

  switch (event.eventType) {
    case 'game_started':
      return {
        icon: '🎮',
        title: 'Permainan Dimulai',
        subtitle: `Desa telah terbentuk dengan ${payload.playerCount ?? 'semua'} warga.`,
      }
    case 'player_joined': {
      const name = (payload.displayName as string) || (payload.playerId ? `Pemain ${String(payload.playerId).slice(0, 4)}` : 'Seseorang')
      const seat = payload.seatNumber ? `(Kursi ${payload.seatNumber})` : ''
      return {
        icon: '👋',
        title: `${name} Bergabung`,
        subtitle: `Warga baru memasuki desa ${seat}`.trim(),
      }
    }
    case 'player_left': {
      const name = (payload.displayName as string) || 'Seseorang'
      return {
        icon: '🚪',
        title: `${name} Meninggalkan Desa`,
        subtitle: 'Seorang warga telah pergi.',
      }
    }
    case 'night_started':
      return {
        icon: '🌙',
        title: `Malam ke-${payload.roundNumber ?? event.roundNumber ?? 1}`,
        subtitle: 'Desa tertidur lelap. Pemegang peran malam beraksi di kegelapan...',
      }
    case 'day_started':
      return {
        icon: '☀️',
        title: `Pagi Hari ke-${payload.roundNumber ?? event.roundNumber ?? 1}`,
        subtitle: 'Fajar menyingsing. Warga berkumpul untuk memeriksa keadaan desa.',
      }
    case 'player_eliminated': {
      const name = (payload.displayName as string) || (payload.playerId ? `Pemain ${String(payload.playerId).slice(0, 4)}` : 'Seseorang')
      return {
        icon: '💀',
        title: `${name} Telah Gugur!`,
        subtitle: 'Satu nyawa melayang dan tidak akan pernah kembali ke desa.',
        badgeColor: 'border-red-500/50 bg-red-950/30 text-red-200',
      }
    }
    case 'voting_started':
      return {
        icon: '🗳️',
        title: `Musyawarah Voting (Hari ${payload.roundNumber ?? event.roundNumber ?? 1})`,
        subtitle: 'Warga desa memberikan suara untuk menentukan siapa yang dicurigai.',
      }
    case 'game_finished': {
      const winner = String(payload.winner || '').toLowerCase()
      const winnerLabel =
        winner === 'tanner'
          ? 'Tanner (Menang Sendirian! 👺)'
          : winner === 'werewolf'
          ? 'Tim Serigala 🐺'
          : 'Warga Desa 👱'
      return {
        icon: '🏆',
        title: 'Permainan Berakhir!',
        subtitle: `Kemenangan untuk: ${winnerLabel}`,
        badgeColor: 'border-amber-500/50 bg-amber-950/40 text-amber-200',
      }
    }
    default:
      return {
        icon: '📜',
        title: event.eventType.replace(/_/g, ' '),
        subtitle: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
      }
  }
}

export function VillageTimeline({ theme, events = [] }: VillageTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events.length])

  return (
    <section
      aria-label="Village Chronicle"
      className={`flex flex-col rounded-2xl border p-3.5 shadow-xl sm:p-4 ${theme.surface}`}
    >
      <div className={`flex items-center justify-between border-b pb-2.5 ${theme.divider}`}>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-base">📜</span>
          <h2 className={`text-xs font-bold uppercase tracking-[0.18em] ${theme.text}`}>
            Village Chronicle
          </h2>
        </div>
        <span className={`text-[10px] font-mono font-medium ${theme.textMuted}`}>
          {events.length} Catatan
        </span>
      </div>

      <div
        ref={scrollRef}
        className="mt-3 flex max-h-64 flex-col gap-2.5 overflow-y-auto sm:max-h-80 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <span aria-hidden="true" className="text-2xl opacity-40">⏳</span>
            <p className={`mt-2 text-xs ${theme.textMuted}`}>Belum ada catatan peristiwa di desa ini.</p>
          </div>
        ) : (
          events.map((event) => {
            const { icon, title, subtitle, badgeColor } = formatNarrative(event)
            return (
              <div
                key={event.id}
                className={`flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-all ${
                  badgeColor || `${theme.surfaceRaised} ${theme.border}`
                }`}
              >
                <span className="flex-shrink-0 text-base leading-tight" aria-hidden="true">
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-semibold leading-tight ${theme.text}`}>
                    {title}
                  </p>
                  {subtitle && (
                    <p className={`mt-0.5 text-[11px] leading-normal ${theme.textMuted}`}>
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
