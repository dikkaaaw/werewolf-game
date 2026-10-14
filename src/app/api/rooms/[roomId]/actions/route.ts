import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { submitActionSchema } from '@/lib/schemas/game';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { advanceRoomPhaseIfExpired } from '@/lib/server/phase-advancement';
import { requireRoomAccess } from '@/lib/server/auth';
import { badRequest, mapEngineError, notFound, ok, tooManyRequests, unauthorized } from '@/lib/server/api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, submitActionSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('submitAction', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many action submissions. Please try again.', retryAfter);
    }

    // Establish membership through the RLS-gated session read BEFORE any
    // privileged work. A non-member and a nonexistent room both get the same
    // 404 here, so the endpoint does not disclose which. The RPC below
    // re-validates authoritatively; this gate exists so an authenticated
    // stranger cannot use the lazy-advancement call to drive the state machine.
    if (!(await requireRoomAccess(supabase, roomId))) {
      return notFound();
    }

    const admin = createAdminClient();

    // Lazy phase advancement (IMPLEMENTATION-PLAN "Scheduler strategy",
    // fallback 3). Without this, an expired night is never resolved unless a
    // client happens to poll GET /api/rooms/:id, and the player gets a bare
    // "the night phase is over" instead of a resolved board.
    //
    // Safe to call on every request:
    //   * no-op when the deadline has not passed;
    //   * the claim token makes concurrent callers mutually exclusive, so two
    //     players acting at once cannot produce two transitions;
    //   * a failure here must NOT mask a legitimate action, so it is swallowed
    //     and the authoritative RPC below still decides the request.
    try {
      await advanceRoomPhaseIfExpired(roomId);
    } catch {
      // Best-effort. The RPC below re-checks phase and deadline authoritatively.
    }

    // Call submit_night_action RPC (server-authoritative; validates phase, timer, alive status, role capability)
    const { data, error } = await admin.rpc('submit_night_action', {
      p_room_id: roomId,
      p_user_id: user.id,
      p_action_type: result.data.actionType,
      p_target_player_id: result.data.targetPlayerId,
    });

    if (error) {
      return badRequest(error.message ?? 'Failed to submit action.');
    }

    const body = data as {
      ok: boolean;
      roundNumber?: number;
      error?: { code: string; message: string };
    };

    if (!body.ok && body.error) {
      return mapEngineError(body.error.code, body.error.message);
    }

    return ok({
      ok: true,
      actionType: result.data.actionType,
      targetPlayerId: result.data.targetPlayerId,
      roundNumber: body.roundNumber,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}
