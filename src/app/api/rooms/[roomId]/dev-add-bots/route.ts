import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { badRequest, forbidden, notFound, ok, unauthorized } from '@/lib/server/api';

const addTestPlayersSchema = z.object({
  count: z.number().int().min(1).max(10).default(3),
  ready: z.boolean().default(true),
});

/**
 * DEVELOPMENT-ONLY ROUTE: Add test players to an active lobby for multiplayer testing.
 *
 * Security:
 * - Completely blocked in production (returns 404).
 * - Requires verified host session.
 * - Only operates on rooms in 'lobby' state.
 * - Creates real auth users via admin API so DB foreign-key invariants are preserved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NEXT_PUBLIC_ALLOW_TEST_BOTS !== 'true'
  ) {
    return notFound();
  }

  try {
    const { roomId } = await params;
    const result = await parseJsonBody(request, addTestPlayersSchema);
    if (!result.ok) return result.response;

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return unauthorized('Authentication required.');
    }

    const admin = createAdminClient();

    // 1. Fetch room & ensure host authorization
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id, host_user_id, status, max_players, room_code')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return notFound('Room not found.');
    }

    if (room.host_user_id !== user.id) {
      return forbidden('Only the room host can add test players.');
    }

    if (room.status !== 'lobby') {
      return badRequest('Cannot add test players to a game that has already started.');
    }

    // 2. Count current players
    const { data: currentPlayers, error: countError } = await admin
      .from('room_players')
      .select('id')
      .eq('room_id', roomId);

    if (countError || !currentPlayers) {
      return badRequest('Failed to count current players.');
    }

    const availableSlots = room.max_players - currentPlayers.length;
    const toAdd = Math.min(result.data.count, availableSlots);

    if (toAdd <= 0) {
      return badRequest('Room is already full.');
    }

    const added: Array<{ playerId: string; displayName: string }> = [];

    // 3. Create simulated players via admin API (preserving auth.users FK invariant)
    for (let i = 1; i <= toAdd; i++) {
      const testUserId = randomUUID();
      const testEmail = `bot-${testUserId.slice(0, 8)}@dev.local`;
      const displayName = `TestBot ${currentPlayers.length + i}`;

      const { error: userError } = await admin.auth.admin.createUser({
        id: testUserId,
        email: testEmail,
        email_confirm: true,
      });

      if (userError) {
        continue;
      }

      // Join room via join_room RPC
      const { data: joinData, error: joinError } = await admin.rpc('join_room', {
        p_room_code: room.room_code,
        p_user_id: testUserId,
        p_display_name: displayName,
      });

      if (joinError) continue;

      const body = joinData as { ok: boolean; playerId?: string };
      if (body.ok && body.playerId) {
        if (result.data.ready) {
          await admin
            .from('room_players')
            .update({ is_ready: true })
            .eq('id', body.playerId);
        }
        added.push({ playerId: body.playerId, displayName });
      }
    }

    // Bump room activity to broadcast realtime update
    await admin
      .from('rooms')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', roomId);

    return ok({
      ok: true,
      addedCount: added.length,
      added,
    });
  } catch {
    return badRequest('Internal server error.');
  }
}
