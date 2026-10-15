import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { chatMessageSchema } from '@/lib/schemas/game';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { requireRoomAccess } from '@/lib/server/auth';
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  tooManyRequests,
  unauthorized,
} from '@/lib/server/api';

export async function GET(
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

    if (!(await requireRoomAccess(supabase, roomId))) {
      return notFound();
    }

    const { data: messages, error } = await supabase
      .from('game_chat_messages')
      .select('id, round_number, author_player_id, message, created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      return badRequest(error.message);
    }

    return ok({ messages: messages ?? [] });
  } catch {
    return badRequest('Failed to fetch messages.');
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, chatMessageSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const rateLimit = await checkRateLimit('sendChat', user.id);
    if (!rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rateLimit.resetAt).getTime() - Date.now()) / 1000),
      );
      return tooManyRequests('Too many messages sent. Please slow down.', retryAfter);
    }

    if (!(await requireRoomAccess(supabase, roomId))) {
      return notFound();
    }

    const admin = createAdminClient();

    // Check room state and caller alive status
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('status, phase, round_number')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return notFound('Room not found.');
    }

    if (room.status !== 'in_progress') {
      return forbidden('Chat is only available during an active game.');
    }

    if (room.phase === 'night') {
      return forbidden('The village is asleep. Chat is closed during the night.');
    }

    const { data: player, error: playerError } = await admin
      .from('room_players')
      .select('id, is_alive, display_name')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .single();

    if (playerError || !player) {
      return notFound('Player not found in this room.');
    }

    if (!player.is_alive) {
      return forbidden('Eliminated players cannot speak in the village chat.');
    }

    const { data: inserted, error: insertError } = await admin
      .from('game_chat_messages')
      .insert({
        room_id: roomId,
        round_number: room.round_number,
        author_player_id: player.id,
        message: result.data.message,
      })
      .select('id, round_number, author_player_id, message, created_at')
      .single();

    if (insertError) {
      return badRequest(insertError.message);
    }

    return ok({
      message: {
        ...inserted,
        authorName: player.display_name,
      },
    });
  } catch {
    return badRequest('Failed to send message.');
  }
}
