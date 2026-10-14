import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { createRoomSchema } from '@/lib/schemas/game';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { badRequest, ok, tooManyRequests, unauthorized } from '@/lib/server/api';

export async function POST(request: Request) {
  try {
    const result = await parseJsonBody(request, createRoomSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('createRoom', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many rooms created. Please try again later.', retryAfter);
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc('create_room', {
      p_user_id: user.id,
      p_display_name: result.data.displayName,
      p_max_players: result.data.maxPlayers,
    });

    if (error) return badRequest(error.message ?? 'create_room RPC failed');

    const body = data as {
      ok: boolean;
      roomId?: string;
      roomCode?: string;
      playerId?: string;
      error?: { code?: string; message: string };
    };
    if (!body.ok) return badRequest(body.error?.message ?? 'Room creation failed.');

    return ok({
      roomId: body.roomId,
      roomCode: body.roomCode,
      playerId: body.playerId,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}