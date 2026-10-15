import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import {
  badRequest,
  conflict,
  forbidden,
  mapEngineError,
  notFound,
  ok,
  parseJsonBody,
  tooManyRequests,
  unauthorized,
} from '@/lib/server/api';
import { updateRoomSettingsSchema } from '@/lib/schemas/game';
import { validateRoleConfig } from '@/lib/game/config-validation';
import { validatePhaseSeconds } from '@/lib/game/room-settings';
import { checkRateLimit } from '@/lib/server/rate-limit';
import type { Json } from '@/types/database';

/**
 * POST /api/rooms/:roomId/settings — host-only lobby configuration.
 *
 * Covers both halves of the lobby Game Settings panel:
 *   - phase durations, persisted into `rooms.settings.phaseSeconds` by the
 *     `set_room_settings` RPC (migration 0011);
 *   - role composition, persisted into `room_role_configs` by the existing
 *     `set_role_config` RPC (migration 0003).
 *
 * Both are validated HERE first, against the live roster, so a payload that
 * cannot be accepted is rejected before anything is written. The RPCs then
 * re-validate under the rooms row lock, which is what actually prevents a
 * concurrent Start Game from interleaving.
 *
 * Identity is never taken from the body: `user.id` comes from the verified
 * Supabase session, and the RPCs independently check it against
 * `rooms.host_user_id`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, updateRoomSettingsSchema);
    if (!result.ok) return result.response;
    const body = result.data;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('updateSettings', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many settings updates. Please slow down.', retryAfter);
    }

    const admin = createAdminClient();

    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id, host_user_id, status, settings')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return notFound('Room not found.');
    }

    // Authorisation: only the host, and only before the game starts. The RPCs
    // repeat both checks under the row lock; doing them here as well means a
    // non-host gets a precise 403 instead of a generic engine error, and a
    // settings write never even reaches the database for a started game.
    if (room.host_user_id !== user.id) {
      return forbidden('Only the room host can change game settings.');
    }
    if (room.status !== 'lobby') {
      return conflict('Game settings are locked once the game starts.', 'game_already_started');
    }

    // --- Validate everything BEFORE writing anything ------------------------
    let roleConfig: import('@/lib/game/types').RoleConfigEntry[] | null = null;
    if (body.roles) {
      const { data: players, error: playersError } = await admin
        .from('room_players')
        .select('id')
        .eq('room_id', roomId);

      if (playersError || !players) {
        return badRequest('Failed to read the current roster.');
      }

      const validation = validateRoleConfig(body.roles, players.length);
      if (!validation.ok) {
        return badRequest(
          `Invalid role configuration: ${validation.issues.map((i) => i.message).join(' ')}`,
          validation.issues,
        );
      }
      roleConfig = validation.config;
    }

    let phaseSeconds: import('@/lib/game/room-settings').PhaseSeconds | null = null;
    if (body.phaseSeconds) {
      const validation = validatePhaseSeconds(body.phaseSeconds);
      if (!validation.ok) {
        return badRequest(
          `Invalid phase durations: ${validation.issues.map((i) => i.message).join(' ')}`,
          validation.issues,
        );
      }
      phaseSeconds = validation.phaseSeconds;
    }

    // --- Persist ------------------------------------------------------------
    // Roles first: if this RPC rejects (the roster changed between our read and
    // its lock), no duration has been written yet, so the failure is clean.
    if (roleConfig) {
      const { data: cfgData, error: cfgError } = await admin.rpc('set_role_config', {
        p_room_id: roomId,
        p_user_id: user.id,
        p_entries: roleConfig as unknown as Json,
      });
      if (cfgError) {
        return badRequest(cfgError.message ?? 'Failed to save the role configuration.');
      }
      const cfgBody = cfgData as { ok?: boolean; error?: { code?: string; message?: string } } | null;
      if (cfgBody && cfgBody.ok === false && cfgBody.error) {
        return mapEngineError(
          cfgBody.error.code ?? 'invalid_config',
          cfgBody.error.message ?? 'Failed to save the role configuration.',
        );
      }
    }

    if (phaseSeconds) {
      const { data: setRes, error: setError } = await admin.rpc('set_room_settings', {
        p_room_id: roomId,
        p_user_id: user.id,
        p_phase_seconds: phaseSeconds as unknown as Json,
      });
      if (setError) {
        return badRequest(setError.message ?? 'Failed to save phase durations.');
      }
      const setBody = setRes as { ok?: boolean; error?: { code?: string; message?: string } } | null;
      if (setBody && setBody.ok === false && setBody.error) {
        return mapEngineError(
          setBody.error.code ?? 'invalid_settings',
          setBody.error.message ?? 'Failed to save phase durations.',
        );
      }
    }

    // Read back the authoritative saved state rather than echoing the request,
    // so the response can never claim a value the database did not accept.
    const { data: saved } = await admin
      .from('rooms')
      .select('settings, state_version')
      .eq('id', roomId)
      .single();

    const { data: savedRoles } = await admin
      .from('room_role_configs')
      .select('role_key, role_count')
      .eq('room_id', roomId);

    return ok({
      ok: true,
      settings: (saved?.settings ?? {}) as Record<string, unknown>,
      roleCounts: Object.fromEntries(
        (savedRoles ?? []).map((r) => [r.role_key, r.role_count]),
      ) as Record<string, number>,
      stateVersion: saved?.state_version ?? null,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}
