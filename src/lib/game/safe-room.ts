/**
 * Shape of the public room snapshot served by `GET /api/rooms/[roomId]`.
 *
 * Mirrors the `safeRoom` projection in that route. It deliberately contains no
 * alignment, night action, or Seer result — those are only ever available
 * through the authorized `/api/rooms/[roomId]/my-role` endpoint.
 *
 * The one exception is `revealedRole`, governed by `isRoleRevealed` in
 * ./reveal.ts: an eliminated player's role while the reveal rule permits it, and
 * every player's role once the game is finished. It is ALWAYS null for a living
 * player during an active game.
 */

export interface SafePlayer {
  id: string;
  /** Always populated by the snapshot route; optional only for legacy callers. */
  userId?: string;
  displayName: string;
  seatNumber: number;
  isAlive: boolean;
  isReady?: boolean;
  deathCause: string | null;
  diedAt: string | null;
  joinedAt: string;
  lastSeenAt: string;
  /**
   * Publicly revealed role, or null when the reveal rule withholds it.
   * Never carries alignment or any other secret.
   */
  revealedRole: string | null;
}

export interface SafeEvent {
  id: number;
  eventType: string;
  publicPayload: Record<string, unknown>;
  roundNumber: number | null;
  createdAt: string;
}

export interface SafeRoom {
  id: string;
  roomCode: string;
  status: string;
  phase: string;
  roundNumber: number;
  phaseEndsAt?: string | null;
  maxPlayers: number;
  currentPlayers: number;
  hostUserId: string;
  expiresAt: string | null;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  winner?: string;
  /**
   * Host-configured phase durations, present only while the room is in the
   * lobby. Null once the game has started — the setup is locked by then, and
   * the field's presence/absence must not become a side channel that tells a
   * client the game has begun.
   */
  phaseSeconds?: { night: number; day: number; voting: number } | null;
  /** Saved `room_role_configs` as `{ roleKey: count }`. Lobby-only, same reason. */
  roleCounts?: Record<string, number> | null;
  votes?: Array<{ voterPlayerId: string; targetPlayerId: string }>;
  events?: SafeEvent[];
  players: SafePlayer[];
}

/**
 * Is this seat the given auth user?
 *
 * Compares ONLY `userId`. The previous implementation also accepted
 * `player.id === userId`, but `player.id` is a `room_players` primary key while
 * `userId` is an `auth.users` id — different ID spaces that can only ever match
 * by coincidence. All four call sites (LobbyPanel and the game page) pass a
 * real auth id, so the fallback was unreachable; keeping it only risked a future
 * ID-confusion mistake. Matching is a hard requirement, so an absent `userId`
 * returns false rather than guessing.
 */
export function isSameUser(
  player: Pick<SafePlayer, 'userId' | 'id'>,
  userId: string | undefined,
): boolean {
  if (!userId || !player.userId) return false;
  return player.userId === userId;
}

/**
 * Whether the lobby is in a state where the host may press Start.
 *
 * Extracted so the button's enabled state is pinned by a test against the same
 * function the page renders with. An earlier inline copy of this check in the
 * room page used a hardcoded 4 and disagreed with both `minStartablePlayers`
 * (5) and the start route, which let a 4-player lobby show an enabled Start
 * button that the server then rejected.
 *
 * The threshold is read from SETTINGS rather than repeated here, so this gate,
 * the start route and the `start_game` RPC cannot drift apart.
 */
export function canStartLobbyGame(
  players: ReadonlyArray<Pick<SafePlayer, 'isReady'>>,
  minStartablePlayers: number,
): boolean {
  return players.length >= minStartablePlayers && players.every((p) => p.isReady);
}
/**
 * Which surface a room's status should present.
 *
 * Extracted for the same reason as `canStartLobbyGame`: the room page decides
 * what to render from `status`, and an inline predicate drifted from it. The
 * play layout was gated on `!isLobby`, which is ALSO true for `finished`, so a
 * terminated game rendered the live layout — banner, role card, roster, chat —
 * on top of the game-over panel. The room had correctly reached `finished`
 * while the screen still looked like a game in progress.
 *
 * Mutually exclusive by construction: exactly one surface is ever returned, so
 * no combination of flags can show a game-over panel next to a live board.
 */
export type RoomSurface = 'lobby' | 'playing' | 'gameOver';

export function roomSurface(status: string | undefined): RoomSurface {
  if (status === 'finished') return 'gameOver';
  if (status === 'in_progress') return 'playing';
  return 'lobby';
}
