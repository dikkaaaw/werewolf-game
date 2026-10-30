import 'server-only';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/server';
import { SETTINGS } from '@/lib/game/settings';

/**
 * Database-backed rate limiting (PRD §18.B).
 *
 * The counter lives in Postgres, not in process memory, because Vercel runs
 * many serverless instances and a per-process counter would let a caller
 * multiply their quota by the number of instances.
 *
 * The increment is a single `INSERT ... ON CONFLICT DO UPDATE`, so concurrent
 * requests cannot lose updates and no read-modify-write race exists.
 */

export type RateLimitBucket = keyof typeof SETTINGS.rateLimits;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

/**
 * Runtime shape of the `consume_rate_limit` RPC response.
 *
 * Parsed rather than cast: the RPC returns `jsonb`, so an unchecked assertion
 * would let a malformed response silently produce `allowed: undefined`.
 */
const consumeResponseSchema = z.object({
  ok: z.boolean(),
  allowed: z.boolean().optional(),
  remaining: z.number().optional(),
  reset_at: z.string().optional(),
});

export async function checkRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): Promise<RateLimitResult> {
  if (process.env.DISABLE_RATE_LIMIT === 'true') {
    return {
      allowed: true,
      remaining: 999,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  const { limit, windowSeconds } = SETTINGS.rateLimits[bucket];
  const admin = createAdminClient();

  const { data, error } = await admin.rpc('consume_rate_limit', {
    p_bucket: bucket,
    p_key: identifier,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  const fallback: RateLimitResult = {
    allowed: true,
    remaining: limit,
    resetAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
  };

  if (error) {
    // Fail OPEN on infrastructure failure: a rate-limiter outage should not
    // take the whole game down. Abuse protection is best-effort here; the
    // authoritative controls (RLS, server-side validation) are unaffected.
    console.error('[rate-limit] RPC failed, failing open:', error.message);
    return fallback;
  }

  const parsed = consumeResponseSchema.safeParse(data);
  if (!parsed.success) {
    console.error('[rate-limit] unexpected RPC response, failing open:', parsed.error.message);
    return fallback;
  }

  const { allowed, remaining, reset_at: resetAt } = parsed.data;

  return {
    allowed: allowed ?? false,
    remaining: remaining ?? 0,
    resetAt: resetAt ?? fallback.resetAt,
  };
}
