import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isRoleRevealed } from '@/lib/game/reveal';
import { isRegisteredRole } from '@/lib/game/role-registry';
import { ok, notFound, tooManyRequests, unauthorized } from '@/lib/server/api';
import { advanceRoomPhaseIfExpired } from '@/lib/server/phase-advancement';
import { checkRateLimit } from '@/lib/server/rate-limit';
import type { RoomPlayerRow } from '@/types/database';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const roomId = (await params).roomId;

  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return unauthorized('Authentication required.');
  }

  // RESOURCE-LIMITS §2: snapshot reads are limited per account. The in-game
  // client heartbeats every 4s (15/min), so this leaves real headroom for the
  // Realtime-driven refetches layered on top of the poll.
  const rateLimit = await checkRateLimit('roomSnapshot', user.id);
  if (!rateLimit.allowed) {
    const retryAfter = Math.max(
      1,
      Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
    );
    return tooManyRequests('Too many room reads. Please slow down.', retryAfter);
  }

  /**
   * Read the room and its roster through the caller's SESSION client, so RLS
   * decides visibility. For a caller who is not a member this yields nothing,
   * which is exactly the authorization gate: it must run BEFORE any privileged
   * work, and its 404 does not disclose whether the room exists.
   */
  const readRoomState = async () => {
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select(
        'id, room_code, status, phase, round_number, phase_ends_at, max_players, host_user_id, expires_at, state_version, created_at, updated_at, settings',
      )
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return null;
    }

    const { data: players, error: playersError } = await supabase
      .from('room_players')
      .select(
        'id, user_id, display_name, seat_number, is_alive, is_ready, death_cause, died_at, joined_at, last_seen_at',
      )
      .eq('room_id', roomId);

    if (playersError) {
      return null;
    }

    return { room, players: (players ?? []) as RoomPlayerRow[] };
  };

  const initial = await readRoomState();
  if (!initial) {
    return notFound();
  }

  // Lazy advancement check per PRD §17.3.
  //
  // This is deliberately AFTER both the authentication check above and the
  // RLS-gated read that proves membership. It runs privileged work (claim ->
  // resolve -> commit/finish, all with the service role), so an unauthenticated
  // or non-member caller must never be able to reach it — otherwise any HTTP
  // client that learned a room id could drive the game state machine.
  await advanceRoomPhaseIfExpired(roomId);

  // Re-read after advancement: the phase may have moved (and players may have
  // been eliminated), so the snapshot must describe the state that resulted
  // rather than the one observed before the transition.
  const advanced = await readRoomState();
  const room = advanced?.room ?? initial.room;
  const typedPlayers = advanced?.players ?? initial.players;

  // If voting phase, fetch public votes for this round (RLS game_votes_member_read applies)
  let votes: Array<{ voter_player_id: string; target_player_id: string }> = [];
  if (room.phase === 'voting') {
    const { data: voteRows } = await supabase
      .from('game_votes')
      .select('voter_player_id, target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', room.round_number);
    votes = voteRows ?? [];
  }

  // --- Role reveal ------------------------------------------------------------
  // Read with the SERVICE ROLE, exactly like `my-role` does, and only AFTER the
  // session user is authenticated and the RLS-protected room read above has
  // confirmed they are a member of this room.
  //
  // It must be the service role: `player_secrets` deliberately has ZERO RLS
  // policies, so the caller's own session client reads nothing at all and every
  // revealedRole would come back null.
  //
  // Two things keep this safe:
  //   * it is scoped to `player_id in (this room's roster ids)` — never a
  //     whole-table read, and structurally unable to reach another room; and
  //   * only `role_key` is selected. Alignment, private_state and Seer results
  //     are never fetched, so they cannot leak through this path even if the
  //     reveal rule were wrong.
  const rosterIds = typedPlayers.map((p) => p.id);
  const secretsByPlayer = new Map<string, string>();
  if (rosterIds.length > 0) {
    const { data: secrets } = await createAdminClient()
      .from('player_secrets')
      .select('player_id, role_key')
      .in('player_id', rosterIds);

    for (const secret of secrets ?? []) {
      secretsByPlayer.set(secret.player_id, secret.role_key);
    }
  }

  const revealSetting = (room.settings as Record<string, unknown> | null)
    ?.revealRoleOnElimination;

  /**
   * Apply the pure rule, then validate the value against the canonical registry
   * before it can reach a client.
   *
   * `player_secrets.role_key` is plain `text` with no CHECK constraint, so a
   * corrupted or hand-written row could hold anything. Echoing an unrecognised
   * string would both leak unknown internals and produce a value the UI cannot
   * render. Anything not in the registry is therefore withheld.
   */
  const revealedRoleFor = (player: RoomPlayerRow): string | null => {
    if (
      !isRoleRevealed({
        roomStatus: room.status,
        revealRoleOnElimination: revealSetting,
        isAlive: player.is_alive,
      })
    ) {
      return null;
    }
    const role = secretsByPlayer.get(player.id);
    if (!role || !isRegisteredRole(role)) {
      return null;
    }
    return role;
  };
  const currentPlayers = typedPlayers.filter((p) => p.is_alive).length;

  // Only return data the lobby UI needs. No private role data, secrets, night actions, or audit logs.
  const safeRoom = {
    id: room.id,
    roomCode: room.room_code,
    status: room.status,
    phase: room.phase,
    roundNumber: room.round_number,
    phaseEndsAt: room.phase_ends_at,
    maxPlayers: room.max_players,
    currentPlayers,
    hostUserId: room.host_user_id,
    expiresAt: room.expires_at,
    stateVersion: room.state_version,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    winner: (room.settings as Record<string, unknown>)?.winner as string | undefined,
    votes: votes.map((v) => ({ voterPlayerId: v.voter_player_id, targetPlayerId: v.target_player_id })),
    players: typedPlayers.map((p) => ({
      id: p.id,
      userId: p.user_id,
      displayName: p.display_name,
      seatNumber: p.seat_number,
      isAlive: p.is_alive,
      isReady: p.is_ready ?? false,
      deathCause: p.death_cause,
      diedAt: p.died_at,
      joinedAt: p.joined_at,
      lastSeenAt: p.last_seen_at,
      // The only role ever present in the public snapshot, and only when
      // `isRoleRevealed` allows it. Always null for a living player in an
      // active game. Own role comes from /my-role instead.
      revealedRole: revealedRoleFor(p),
    })),
  };

  return ok({ room: safeRoom, roomId });
}