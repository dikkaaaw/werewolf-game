import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { startGameSchema } from '@/lib/schemas/game';
import { getDefaultRoleConfig } from '@/lib/game/default-roles';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { assignRoles } from '@/lib/game/role-assignment';
import { SETTINGS } from '@/lib/game/settings';
import { badRequest, conflict, forbidden, notFound, ok, unauthorized } from '@/lib/server/api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, startGameSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const admin = createAdminClient();

    // 1. Fetch room details
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id, host_user_id, status, max_players, settings')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return notFound('Room not found.');
    }

    // 2. Authorisation: Only the host may start the game
    if (room.host_user_id !== user.id) {
      return forbidden('Only the room host can start the game.');
    }

    // 3. Race condition / double-start prevention
    if (room.status !== 'lobby') {
      return conflict('Game has already started.', 'game_already_started');
    }

    // 4. Fetch all current alive players
    const { data: players, error: playersError } = await admin
      .from('room_players')
      .select('id, seat_number, is_alive, is_ready')
      .eq('room_id', roomId)
      .order('seat_number', { ascending: true });

    if (playersError || !players) {
      return badRequest('Failed to fetch room players.');
    }

    const alivePlayers = players.filter((p) => p.is_alive);
    const playerCount = alivePlayers.length;

    // Minimum players required. The threshold comes from SETTINGS (not a
    // literal) so this route, the lobby UI and the start_game RPC cannot drift.
    const minStartable = SETTINGS.gameplay.minStartablePlayers;
    if (playerCount < minStartable) {
      return badRequest(`Need at least ${minStartable} players to start (got ${playerCount}).`);
    }

    // All players must be Ready (excluding host if host starts, or host also must be ready)
    // Non-host players must be marked ready
    const unreadyPlayers = alivePlayers.filter((p) => !p.is_ready);
    if (unreadyPlayers.length > 0) {
      return badRequest(`Cannot start game: ${unreadyPlayers.length} player(s) are not ready.`);
    }

    // 5. Determine and validate role configuration
    const requestedRoles = result.data.roles ?? getDefaultRoleConfig(playerCount);
    const validation = validateRoleConfig(requestedRoles, playerCount);

    if (!validation.ok) {
      return badRequest(
        `Invalid role configuration: ${validation.issues.map((i) => i.message).join(' ')}`,
      );
    }

    // Persist role config first via RPC
    const { error: cfgError } = await admin.rpc('set_role_config', {
      p_room_id: roomId,
      p_user_id: user.id,
      p_entries: validation.config as unknown as import('@/types/database').Json,
    });

    if (cfgError) {
      return badRequest(cfgError.message ?? 'Failed to set role configuration.');
    }

    // 6. Assign roles using CSPRNG
    const assignable = alivePlayers.map((p) => ({
      playerId: p.id,
      seatNumber: p.seat_number,
    }));
    const { assignments } = assignRoles(assignable, validation.config);

    // 7. Call privileged RPC start_game
    const nightSeconds = result.data.nightSeconds ?? 60;
    const { data: startData, error: startError } = await admin.rpc('start_game', {
      p_room_id: roomId,
      p_user_id: user.id,
      p_assignments: assignments.map((a) => ({
        playerId: a.playerId,
        roleKey: a.roleKey,
        alignment: a.alignment,
      })),
      p_night_seconds: nightSeconds,
    });

    if (startError) {
      return badRequest(startError.message ?? 'start_game RPC failed');
    }

    const body = startData as { ok: boolean; roundNumber?: number; error?: { message: string } };
    if (!body.ok) {
      return badRequest(body.error?.message ?? 'Failed to start game.');
    }

    return ok({
      ok: true,
      roundNumber: body.roundNumber ?? 1,
      playerCount,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}
