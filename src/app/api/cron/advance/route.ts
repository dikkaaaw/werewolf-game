import 'server-only';

import { advanceRoomPhaseIfExpired } from '@/lib/server/phase-advancement';
import { createAdminClient } from '@/lib/supabase/server';
import { apiError, ok } from '@/lib/server/api';

/**
 * POST /api/cron/advance — the external scheduler hook.
 *
 * This is deliberately thin. It does NOT implement phase logic and it does NOT
 * add a second concurrency mechanism: every room is advanced by the existing
 * `tick_room` RPC (via `advanceRoomPhaseIfExpired`), which already takes the
 * room row lock and is a no-op unless the phase deadline has passed. Running
 * this endpoint twice in parallel is therefore safe.
 *
 * Why it exists: with only lazy advancement, a room whose players have all
 * closed their tabs sits past its deadline forever. An external cron hitting
 * this route is what makes the game advance with zero player traffic.
 *
 * Auth: `Authorization: Bearer <SCHEDULER_SECRET>` (or `x-cron-secret`).
 */

/** Bound one invocation so a backlog can never turn into an unbounded scan. */
const MAX_ROOMS_PER_RUN = 200;

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return apiError(401, 'unauthorized', 'Unauthorized.');
  }

  const admin = createAdminClient();

  // Only rooms that are actually playable and past their deadline. Rows waiting
  // on a Hunter prompt are still scanned: `tick_room` clears an expired prompt
  // itself, and returns a harmless "not advanced" while one is genuinely live.
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('rooms')
    .select('id')
    .eq('status', 'in_progress')
    .lte('phase_ends_at', now)
    .limit(MAX_ROOMS_PER_RUN);

  if (error) {
    return apiError(500, 'internal_error', 'Could not read due rooms.');
  }

  const due = (data ?? []) as Array<{ id: string }>;
  const advanced: string[] = [];
  const failed: Array<{ roomId: string; message: string }> = [];

  for (const room of due) {
    try {
      if (await advanceRoomPhaseIfExpired(room.id)) {
        advanced.push(room.id);
      }
    } catch (err) {
      failed.push({
        roomId: room.id,
        message: err instanceof Error ? err.message : 'Unknown error.',
      });
    }
  }

  return ok({
    ok: true,
    scanned: due.length,
    advanced,
    failed,
  });
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = bearer || request.headers.get('x-cron-secret') || '';;

  return timingSafeEqual(provided, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}
