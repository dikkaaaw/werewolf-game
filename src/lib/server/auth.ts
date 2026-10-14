import 'server-only';

import { createServerClient } from '@/lib/supabase/server';

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
}

/**
 * Resolve the caller's identity from their verified auth session.
 *
 * Returns `null` when there is no session. There is deliberately no
 * `userId` parameter anywhere in this codebase's server helpers: identity is
 * never accepted from a request body, only from a verified session
 * (PRD §2 "Security Requirements").
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  return { userId: user.id, email: user.email ?? null };
}

/**
 * Confirm the caller may access this room — without disclosing whether it exists.
 *
 * Reads through the caller's SESSION client, so RLS decides visibility. A
 * caller who is not a member and a caller naming a nonexistent room both get
 * zero rows, and both map to the same 404. That is deliberate: it is the
 * authorization gate AND the room-existence oracle fix.
 *
 * Must run BEFORE any privileged work (phase advancement, secret reads). The
 * snapshot route uses the same ordering.
 */
export async function requireRoomAccess(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  roomId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('rooms')
    .select('id')
    .eq('id', roomId)
    .single();

  return !error && data !== null;
}

/**
 * Get the caller's `room_players` row for a room, or null.
 *
 * Membership is always resolved by (room_id, authenticated user_id). A
 * `player_id` supplied by the client is never used for authorisation.
 */
export async function getRoomMembership(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  roomId: string,
  userId: string,
): Promise<{ playerId: string; isAlive: boolean; seatNumber: number } | null> {
  const { data, error } = await supabase
    .from('room_players')
    .select('id, is_alive, seat_number')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return { playerId: data.id, isAlive: data.is_alive, seatNumber: data.seat_number };
}
