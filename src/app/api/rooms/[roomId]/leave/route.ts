import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { apiError, mapEngineError, ok, unauthorized } from '@/lib/server/api';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc('leave_room', {
      p_room_id: roomId,
      p_user_id: user.id,
    });

    if (error) {
      return apiError(400, 'leave_failed', error.message);
    }

    const body = data as {
      ok?: boolean;
      removedFromLobby?: boolean;
      markedEliminated?: boolean;
      newHostUserId?: string | null;
      error?: { code?: string; message?: string };
    } | null;

    if (!body?.ok && body?.error) {
      return mapEngineError(body.error.code ?? 'leave_failed', body.error.message ?? 'Failed to leave room.');
    }

    return ok({
      ok: true,
      removedFromLobby: body?.removedFromLobby ?? false,
      markedEliminated: body?.markedEliminated ?? false,
      newHostUserId: body?.newHostUserId ?? null,
    });
  } catch (err) {
    console.error('[leave-room] error:', err);
    return apiError(500, 'internal_error', 'Failed to leave room.');
  }
}
