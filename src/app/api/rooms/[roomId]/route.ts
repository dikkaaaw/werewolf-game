import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isRoleRevealed } from '@/lib/game/reveal';
import { isRegisteredRole } from '@/lib/game/role-registry';
import { phaseSecondsFromRoomSettings } from '@/lib/game/room-settings';
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
    const [roomResult, playersResult] = await Promise.all([
      supabase
        .from('rooms')
        .select(
          'id, room_code, status, phase, round_number, phase_ends_at, max_players, host_user_id, expires_at, state_version, created_at, updated_at, settings',
        )
        .eq('id', roomId)
        .single(),
      supabase
        .from('room_players')
        .select(
          'id, user_id, display_name, seat_number, is_alive, is_ready, death_cause, died_at, joined_at, last_seen_at',
        )
        .eq('room_id', roomId),
    ]);

    if (roomResult.error || !roomResult.data || playersResult.error) {
      return null;
    }

    return { room: roomResult.data, players: (playersResult.data ?? []) as RoomPlayerRow[] };
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
  //
  // It returns true ONLY when a transition actually settled. The unconditional
  // re-read that used to follow cost a second room+roster round trip on every
  // single poll, and in a 15-second heartbeat world that is the majority of the
  // snapshot's database cost for a phase that has not expired yet.
  const advanced = (await advanceRoomPhaseIfExpired(roomId))
    ? await readRoomState()
    : null;
  const room = advanced?.room ?? initial.room;
  const typedPlayers = advanced?.players ?? initial.players;

  // Execute supplementary parallel reads based on room state
  const isLobbySnapshot = room.status === 'lobby';
  const rosterIds = typedPlayers.map((p) => p.id);
  const anyRevealable = room.status === 'finished' || typedPlayers.some((p) => !p.is_alive);

  const [voteRowsRes, eventRowsRes, secretsRes, roleRowsRes] = await Promise.all([
    room.phase === 'voting'
      ? supabase
          .from('game_votes')
          .select('voter_player_id, target_player_id')
          .eq('room_id', roomId)
          .eq('round_number', room.round_number)
      : Promise.resolve({ data: [] }),

    room.status !== 'lobby'
      ? supabase
          .from('game_events')
          .select('id, event_type, public_payload, round_number, created_at')
          .eq('room_id', roomId)
          .order('id', { ascending: true })
          .limit(50)
      : Promise.resolve({ data: [] }),

    anyRevealable && rosterIds.length > 0
      ? createAdminClient()
          .from('player_secrets')
          .select('player_id, role_key')
          .in('player_id', rosterIds)
      : Promise.resolve({ data: [] }),

    isLobbySnapshot
      ? supabase
          .from('room_role_configs')
          .select('role_key, role_count')
          .eq('room_id', roomId)
      : Promise.resolve({ data: [] }),
  ]);

  const votes = (voteRowsRes.data ?? []) as Array<{ voter_player_id: string; target_player_id: string }>;
  const events = (eventRowsRes.data ?? []) as Array<{ id: number; event_type: string; public_payload: unknown; round_number: number | null; created_at: string }>;

  const secretsByPlayer = new Map<string, string>();
  for (const secret of secretsRes.data ?? []) {
    secretsByPlayer.set(secret.player_id, secret.role_key);
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

  const phaseSeconds = isLobbySnapshot
    ? phaseSecondsFromRoomSettings(room.settings)
    : null;
  const roleCounts: Record<string, number> | null = isLobbySnapshot
    ? Object.fromEntries(
        (roleRowsRes.data ?? []).map((r: { role_key: string; role_count: number }) => [
          r.role_key,
          r.role_count,
        ]),
      )
    : null;

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
    phaseSeconds,
    roleCounts,
    votes: votes.map((v) => ({ voterPlayerId: v.voter_player_id, targetPlayerId: v.target_player_id })),
    events: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      publicPayload: (e.public_payload as Record<string, unknown>) ?? {},
      roundNumber: e.round_number,
      createdAt: e.created_at,
    })),
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