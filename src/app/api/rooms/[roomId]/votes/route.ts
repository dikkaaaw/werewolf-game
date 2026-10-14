import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { castVoteSchema } from '@/lib/schemas/game';
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
    const result = await parseJsonBody(request, castVoteSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('submitVote', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many votes submitted. Please try again.', retryAfter);
    }

    // Same gate as the actions route: membership before privileged advancement,
    // and no room-existence oracle. See actions/route.ts for the rationale.
    if (!(await requireRoomAccess(supabase, roomId))) {
      return notFound();
    }

    const admin = createAdminClient();

    // Lazy phase advancement (IMPLEMENTATION-PLAN "Scheduler strategy",
    // fallback 3). Resolves an expired day/voting phase before the vote is
    // judged, so a player who votes just after the deadline gets the resolved
    // board instead of a bare rejection, and so the vote is never counted into
    // a phase that had already been closed by another request.
    //
    // No-op when the deadline has not passed; the claim token keeps concurrent
    // callers from producing duplicate transitions. Swallowed on failure so a
    // transient error here cannot reject a request cast_vote would accept.
    try {
      await advanceRoomPhaseIfExpired(roomId);
    } catch {
      // Best-effort. cast_vote below re-checks phase and deadline authoritatively.
    }

    // Call cast_vote RPC (server-authoritative; validates phase, timer, voter alive, target alive in same room)
    const { data, error } = await admin.rpc('cast_vote', {
      p_room_id: roomId,
      p_user_id: user.id,
      p_target_player_id: result.data.targetPlayerId,
    });

    if (error) {
      return badRequest(error.message ?? 'Failed to cast vote.');
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
      targetPlayerId: result.data.targetPlayerId,
      roundNumber: body.roundNumber,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}
