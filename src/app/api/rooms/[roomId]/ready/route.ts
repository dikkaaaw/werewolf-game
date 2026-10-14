import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { toggleReadySchema } from '@/lib/schemas/game';
import { badRequest, conflict, notFound, ok, unauthorized } from '@/lib/server/api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, toggleReadySchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const admin = createAdminClient();

    // 1. Check room exists and is in 'lobby' status
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id, status')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return notFound('Room not found.');
    }

    if (room.status !== 'lobby') {
      return conflict('Cannot toggle ready status after game has started.', 'game_already_started');
    }

    // 2. Verify membership: player must be in this room with verified session user.id
    const { data: player, error: playerError } = await admin
      .from('room_players')
      .select('id, seat_number, is_alive')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .single();

    if (playerError || !player) {
      return notFound('You are not a member of this room.');
    }

    if (!player.is_alive) {
      return badRequest('Eliminated players cannot change ready state.');
    }

    // 3. Update ready state in database
    const targetReady = result.data.isReady;
    const { error: updateError } = await admin
      .from('room_players')
      .update({ is_ready: targetReady })
      .eq('id', player.id);

    if (updateError) {
      return badRequest(updateError.message);
    }

    // 4. Update room last_activity and state_version to trigger Realtime listeners
    await admin
      .from('rooms')
      .update({
        last_activity_at: new Date().toISOString(),
        state_version: room.status === 'lobby' ? 1 : 2,
      })
      .eq('id', roomId);

    return ok({ ok: true, isReady: targetReady, ready: targetReady, playerId: player.id });
  } catch {
    return badRequest('Internal server error.');
  }
}
