import 'server-only';

import { createServerClient, createAdminClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { notFound, tooManyRequests, unauthorized, ok } from '@/lib/server/api';

/**
 * GET /api/rooms/[roomId]/my-role
 *
 * Returns the CALLER's own private role assignment. This is the only path a
 * client may use to learn its own role; other players' secrets are never
 * reachable from here because both privileged queries are keyed on the
 * authenticated `user.id` (membership) and the resulting `player_id`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;

    // 1. Identity comes exclusively from the verified server session.
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    // 2. Rate limited per account (RESOURCE-LIMITS §2).
    const rateLimit = await checkRateLimit('myRole', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many role reads. Please slow down.', retryAfter);
    }

    const admin = createAdminClient();

    // 3. Membership gate: scoped to THIS user and THIS room. A caller who is
    //    not a member matches zero rows, so no role data is ever read.
    const {
      data: player,
      error: playerError,
    } = await admin
      .from('room_players')
      .select('id, seat_number, display_name, is_alive, prompt, prompt_deadline_at')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .single();

    if (playerError || !player) {
      return notFound('Player not found in this room.');
    }

    // 4. Only the caller's own secret row, keyed on the player id resolved above.
    const {
      data: secret,
      error: secretError,
    } = await admin
      .from('player_secrets')
      .select('role_key, alignment')
      .eq('player_id', player.id)
      .single();

    if (secretError || !secret) {
      return notFound('Role not yet assigned or secrets not found.');
    }

    // 5. The caller's own investigation history, still scoped to this player.
    const { data: results } = await admin
      .from('game_action_results')
      .select('round_number, result_payload, created_at')
      .eq('room_id', roomId)
      .eq('actor_player_id', player.id)
      .order('round_number', { ascending: true });

    // 6. Whether the caller has already acted, and on whom. The UI needs this to
    //    stop offering an action the server would reject anyway — otherwise the
    //    button reloads and silently does nothing. Keyed on the current round so
    //    it clears by itself when the phase advances.
    const { data: room } = await admin
      .from('rooms')
      .select('round_number')
      .eq('id', roomId)
      .single();

    const { data: myAction } = await admin
      .from('game_actions')
      .select('action_type, target_player_id')
      .eq('room_id', roomId)
      .eq('actor_player_id', player.id)
      .eq('round_number', room?.round_number ?? -1)
      .maybeSingle();


    // Private prompt (owner-only): this caller holds an unanswered prompt, e.g.
    // a dead Hunter's final shot. The deadline lives on the player row, so it
    // survives reloads and server restarts.
    let hunterAction: { deadlineAt: string; targets: Array<{ id: string; displayName: string }> } | null = null;
    const prompt = player.prompt as { type?: string } | null;
    if (prompt?.type === 'hunter_final_shot') {
      const { data: roster } = await admin
        .from('room_players')
        .select('id, display_name, is_alive')
        .eq('room_id', roomId);

      hunterAction = {
        deadlineAt: player.prompt_deadline_at ?? new Date(Date.now() + 30_000).toISOString(),
        targets: (roster ?? [])
          .filter((r) => r.is_alive)
          .map((r) => ({ id: r.id, displayName: r.display_name })),
      };
    }

    return ok({
      playerId: player.id,
      displayName: player.display_name,
      seatNumber: player.seat_number,
      roleKey: secret.role_key,
      alignment: secret.alignment,
      nightAction: myAction
        ? {
            actionType: myAction.action_type,
            targetPlayerId: myAction.target_player_id,
          }
        : null,
      investigations: (results ?? []).map((r) => ({
        roundNumber: r.round_number,
        result: r.result_payload,
      })),
      ...(hunterAction ? { hunterAction } : {}),
    });
  } catch {
    return notFound('Error fetching role.');
  }
}