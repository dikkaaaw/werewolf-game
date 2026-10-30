import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';

import { logPhase } from '@/lib/server/logger';

/**
 * Lazy phase advancement fallback.
 *
 * Atomically advances the room phase if the current phase has expired,
 * handling night resolution, day discussion, voting resolution, prompt expiry,
 * and win conditions in a single database transaction via `tick_room`.
 */
export async function advanceRoomPhaseIfExpired(roomId: string): Promise<boolean> {
  const admin = createAdminClient();
  const startTime = Date.now();

  try {
    const { data, error } = await admin.rpc('tick_room', { p_room_id: roomId });
    const durationMs = Date.now() - startTime;

    if (error) {
      console.error('[advanceRoomPhase] RPC error:', error);
      logPhase({
        roomId,
        durationMs,
        advanced: false,
        reason: error.message,
      });
      return false;
    }

    const body = data as {
      ok?: boolean;
      advanced?: boolean;
      nextPhase?: string;
      roundNumber?: number;
      reason?: string;
    } | null;

    const advanced = Boolean(body?.ok && body?.advanced);
    logPhase({
      roomId,
      toPhase: body?.nextPhase,
      roundNumber: body?.roundNumber,
      durationMs,
      advanced,
      reason: body?.reason,
    });

    return advanced;
  } catch (err) {
    console.error('[advanceRoomPhase] error calling tick_room:', err);
    logPhase({
      roomId,
      durationMs: Date.now() - startTime,
      advanced: false,
      reason: err instanceof Error ? err.message : 'Unknown exception',
    });
    return false;
  }
}

/**
 * Minimal structural type for the admin client used by the insert-idempotency
 * check. Declared locally so the helper stays unit-testable without importing
 * the full `server-only` Supabase module.
 */
export interface ActionResultsReader {
  from(table: 'game_action_results'): {
    select(columns: string): ActionResultsFilter;
  };
}

/** One `.eq(...)` step. Each call returns another filter, so the chain is
 *  self-referential rather than typed at a fixed depth. */
export interface ActionResultsFilter {
  eq(column: string, value: string): ActionResultsFilter & {
    maybeSingle(): PromiseLike<{
      data: { result_payload: unknown } | null;
      error: { message?: string } | null;
    }>;
  };
}

/**
 * Handles a PostgreSQL error from inserting a Seer investigation result into
 * public.game_action_results.
 *
 * A unique-violation (23505) is only accepted as idempotent success after
 * reading back the conflicting row and confirming its payload matches the
 * investigation this run produced. A duplicate that is missing, or that
 * disagrees about the target or the alignment, is a real inconsistency and
 * fails loudly instead of being swallowed. Every other error code propagates.
 */
export async function handleInsertResultError(
  reader: ActionResultsReader,
  error: { code: string | null; message?: string } | null,
  actionRowId: string,
  targetPlayerId: string,
  targetAlignment: string,
): Promise<void> {
  if (!error) return;
  if (error.code !== '23505') {
    throw error;
  }

  const { data: existingRow, error: readError } = await reader
    .from('game_action_results')
    .select('result_payload')
    .eq('action_id', actionRowId)
    .eq('result_type', 'investigate')
    .maybeSingle();
  if (readError) throw readError;

  const payload = existingRow?.result_payload as
    | { targetPlayerId?: string; alignment?: string }
    | null
    | undefined;

  if (
    !payload ||
    payload.targetPlayerId !== targetPlayerId ||
    payload.alignment !== targetAlignment
  ) {
    throw new Error(
      'Seer result idempotency check failed: existing payload does not match expected investigation.',
    );
  }
}
