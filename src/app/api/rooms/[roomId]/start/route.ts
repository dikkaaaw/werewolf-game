import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { startGameSchema } from '@/lib/schemas/game';
import { getDefaultRoleConfig } from '@/lib/game/default-roles';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { assignRoles } from '@/lib/game/role-assignment';
import { phaseSecondsFromRoomSettings } from '@/lib/game/room-settings';
import { SETTINGS } from '@/lib/game/settings';
import { badRequest, conflict, forbidden, notFound, ok, unauthorized } from '@/lib/server/api';
import type { RoleConfigEntry } from '@/lib/game/types';

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

    // 5. Determine and validate role configuration.
    //
    // Precedence: an explicit request body wins (tests and the dev harness send
    // one), then the configuration the host already saved in the lobby, and only
    // then the balanced default. The old order was body-or-default, which threw
    // away anything the host had configured through the settings panel and dealt
    // a default distribution they had explicitly changed.
    const requestedRoles = result.data.roles ?? (await loadSavedRoleConfig(admin, roomId)) ?? getDefaultRoleConfig(playerCount);
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

    // 7. Call privileged RPC start_game.
    //
    // Duration precedence: an explicit request value, then the host's saved
    // `settings.phaseSeconds.night`, then the built-in default. A literal 60
    // here used to override whatever the host had configured, so the first night
    // ignored their setting even though every later phase honoured it.
    const nightSeconds =
      result.data.nightSeconds ?? phaseSecondsFromRoomSettings(room.settings).night;
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

/**
 * Read the composition the host saved in the lobby, or null when none exists.
 *
 * Only the four engine-known keys are carried through, and the rows are sorted
 * so the resulting array is stable across calls (the assignment shuffle is
 * seeded independently, but a deterministic input keeps the RPC payload and any
 * audit trail comparable between attempts).
 */
async function loadSavedRoleConfig(
  admin: ReturnType<typeof createAdminClient>,
  roomId: string,
): Promise<RoleConfigEntry[] | null> {
  const { data: rows, error } = await admin
    .from('room_role_configs')
    .select('role_key, role_count')
    .eq('room_id', roomId)
    .order('role_key', { ascending: true });

  if (error || !rows || rows.length === 0) return null;

  const entries: RoleConfigEntry[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.role_count) || row.role_count <= 0) continue;
    entries.push({ roleKey: row.role_key, roleCount: row.role_count, config: {} });
  }

  return entries.length > 0 ? entries : null;
}
