'use client'

import { isSameUser, type SafePlayer, type SafeRoom } from '@/lib/game/safe-room'
import { getPlayerAvatar, orderRoster } from '@/lib/game/player-avatar'
import type { PhaseTheme } from '@/lib/game/phase-theme'

export type NightActionType = 'eliminate' | 'investigate' | 'protect'

export interface PlayerRosterProps {
  room: SafeRoom
  theme: PhaseTheme
  /** Auth id of the signed-in user, for "you" / "self" handling. */
  userId: string | undefined
  myPlayer: SafePlayer | undefined
  /** Role key of the caller, or null. Decides which night button is offered. */
  myRoleKey: string | null
  /** Target of the caller's night action this round, if it exists. */
  myNightTargetId: string | null
  /** Whether the caller has already acted this round; locks every button. */
  hasActedThisRound: boolean
  myVoteTargetId: string | null
  actionLoading: string | null
  onNightAction: (playerId: string, actionType: NightActionType) => void
  onCastVote: (playerId: string) => void
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  )
}

/**
 * In-game roster.
 *
 * One column on purpose. Werewolf is a list of suspects you compare against
 * each other, and a 2- or 3-column grid breaks that reading — neighbours become
 * whatever the grid happened to line up. A single column keeps every player on
 * the same eye-line, and leaves room for a vote bar to be read against the
 * others.
 *
 * Every row carries the same `min-h`, whatever the phase. Rows used to grow
 * when the night action button appeared, which shifted everything below them and
 * made the page jump on every phase transition.
 */
export function PlayerRoster({
  room,
  theme,
  userId,
  myPlayer,
  myRoleKey,
  myNightTargetId,
  hasActedThisRound,
  myVoteTargetId,
  actionLoading,
  onNightAction,
  onCastVote,
}: PlayerRosterProps) {
  const isNight = room.status === 'in_progress' && room.phase === 'night'
  const isVoting = room.status === 'in_progress' && room.phase === 'voting'
  const isFinished = room.status === 'finished'

  const nightActionLabel =
    myRoleKey === 'werewolf' ? 'Eat' : myRoleKey === 'seer' ? 'Investigate' : 'Protect'
  const nightActionType: NightActionType =
    myRoleKey === 'werewolf' ? 'eliminate' : myRoleKey === 'seer' ? 'investigate' : 'protect'

  const canActAtNight = Boolean(
    isNight && !hasActedThisRound && ['werewolf', 'seer', 'guardian_angel'].includes(myRoleKey ?? ''),
  )

  const living = room.players.filter((p) => p.isAlive).length
  const ordered = orderRoster(room.players)

  return (
    <section
      aria-label="Players"
      className={`rounded-2xl border p-3 shadow-xl sm:p-4 ${theme.surface}`}
    >
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-2.5 ${theme.divider}`}
      >
        <h2 className={`text-[11px] font-bold uppercase tracking-[0.18em] ${theme.text}`}>
          Players ({living}/{room.players.length})
        </h2>
        <span className={`text-[11px] ${theme.textMuted}`}>
          {isNight
            ? 'Choose your target'
            : isVoting
              ? 'Choose a suspect to vote for'
              : isFinished
                ? 'Final roster'
                : 'Discuss, then be ready to vote'}
        </span>
      </div>

      <ul className="mt-2 flex flex-col gap-1.5">
        {ordered.map((player) => {
          const isCurrentUser = isSameUser(player, userId)
          const isPlayerHost = isSameUser(player, room.hostUserId)

          const rowActionable = Boolean(
            canActAtNight && myPlayer?.isAlive && player.isAlive && !isCurrentUser,
          )
          const isNightTarget = myNightTargetId === player.id
          const isVoteTarget = myVoteTargetId === player.id
          const canVoteForPlayer = Boolean(
            isVoting && myPlayer?.isAlive && player.isAlive && !isCurrentUser,
          )
          const voteTally =
            room.votes?.filter((vote) => vote.targetPlayerId === player.id).length ?? 0
          const avatar = getPlayerAvatar(player.id, player.displayName, player.seatNumber)

          return (
            <li
              key={player.id}
              className={`flex min-h-[3.25rem] items-center gap-2.5 rounded-xl border px-2.5 py-2 transition motion-reduce:transition-none ${
                !player.isAlive
                  ? `${theme.surfaceRaised} opacity-50`
                  : isVoteTarget || isNightTarget
                    ? `${theme.surfaceRaised} ring-1 ${theme.accentBorder}`
                    : `${theme.surfaceRaised} ${theme.border}`
              } ${
                // Night: dim everything the caller cannot act on, so a stray
                // click cannot fire an action at the wrong person.
                isNight && player.isAlive && !rowActionable && !isCurrentUser ? 'opacity-40' : ''
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold ${avatar.surfaceClass} ${avatar.textClass}`}
              >
                {avatar.initials}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`truncate text-sm font-semibold ${
                      player.isAlive ? theme.text : `line-through ${theme.textFaint}`
                    }`}
                  >
                    {player.displayName}
                  </span>
                  {isCurrentUser && (
                    <span
                      className={`rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${theme.accentBorder} ${theme.accentSoft} ${theme.accent}`}
                    >
                      You
                    </span>
                  )}
                  {isPlayerHost && (
                    <span className="rounded border border-indigo-500/50 bg-indigo-500/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-indigo-300">
                      Host
                    </span>
                  )}
                  <span className={`ml-auto shrink-0 font-mono text-[10px] ${theme.textFaint}`}>
                    #{player.seatNumber}
                  </span>
                </div>

                {!player.isAlive && (
                  <p className="font-mono text-[10px] text-rose-400">
                    ☠{' '}
                    {player.deathCause === 'night_elimination' ? 'Lost at night' : 'Lynched'}
                  </p>
                )}
                {/* Publicly revealed role. The server only sends this for an
                    eliminated player under the room's reveal rule, or for anyone
                    once the game is finished. */}
                {player.revealedRole && (
                  <p className="font-mono text-[10px] uppercase tracking-wider text-amber-300/90">
                    {player.revealedRole}
                  </p>
                )}

                {isVoting && voteTally > 0 && (
                  <div
                    aria-hidden="true"
                    className={`mt-1 h-1 w-full overflow-hidden rounded-full ${theme.border}`}
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${theme.accent}`}
                      style={{ width: `${Math.max(12, (voteTally / Math.max(1, room.votes?.length ?? 1)) * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {isNight && (rowActionable || isNightTarget) && (
                  <button
                    type="button"
                    onClick={
                      isNightTarget || hasActedThisRound || actionLoading !== null
                        ? undefined
                        : () => onNightAction(player.id, nightActionType)
                    }
                    disabled={actionLoading !== null || isNightTarget || hasActedThisRound}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${
                      isNightTarget ? theme.buttonPrimary : theme.buttonNeutral
                    }`}
                  >
                    {actionLoading === `night-${player.id}` ? (
                      <Spinner />
                    ) : isNightTarget ? (
                      '✓ Set'
                    ) : (
                      nightActionLabel
                    )}
                  </button>
                )}

                {isNight && !rowActionable && myPlayer?.isAlive && isCurrentUser && (
                  <span className={`font-mono text-[10px] italic ${theme.textFaint}`}>Self</span>
                )}

                {isVoting && (
                  <div className="flex items-center gap-2">
                    {voteTally > 0 && (
                      <span
                        className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                          isVoteTarget
                            ? `${theme.accentSoft} ${theme.accentBorder} ${theme.accent}`
                            : `${theme.surfaceRaised} ${theme.textMuted}`
                        }`}
                      >
                        {voteTally}
                      </span>
                    )}
                    {canVoteForPlayer && (
                      <button
                        type="button"
                        onClick={isVoteTarget ? undefined : () => onCastVote(player.id)}
                        disabled={actionLoading !== null || isVoteTarget}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${
                          isVoteTarget ? theme.buttonPrimary : theme.buttonNeutral
                        }`}
                      >
                        {actionLoading === `vote-${player.id}` ? (
                          <Spinner />
                        ) : isVoteTarget ? (
                          '✓ Voted'
                        ) : (
                          'Vote'
                        )}
                      </button>
                    )}
                    {isCurrentUser && (
                      <span className={`font-mono text-[10px] italic ${theme.textFaint}`}>Self</span>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}