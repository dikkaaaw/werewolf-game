import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { joinRoomSchema } from '@/lib/schemas/game';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { badRequest, ok, tooManyRequests, unauthorized } from '@/lib/server/api';

export async function POST(request: Request) {
  try {
    const result = await parseJsonBody(request, joinRoomSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('joinRoom', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many join attempts. Please try again later.', retryAfter);
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc('join_room', {
      p_room_code: result.data.roomCode,
      p_user_id: user.id,
      p_display_name: result.data.displayName,
    });

    if (error) return badRequest(error.message ?? 'join_room RPC failed');

    const body = data as {
      ok: boolean;
      roomId?: string;
      roomCode?: string;
      playerId?: string;
      seatNumber?: number;
      playerCount?: number;
      error?: { code?: string; message: string };
    };
    if (!body.ok) return badRequest(body.error?.message ?? 'Failed to join room.');

    return ok({
      playerId: body.playerId,
      roomId: body.roomId,
      roomCode: body.roomCode,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}