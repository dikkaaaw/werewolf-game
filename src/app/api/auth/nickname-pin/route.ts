import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { apiError, ok, parseJsonBody, tooManyRequests } from '@/lib/server/api';
import { SETTINGS } from '@/lib/game/settings';

const authSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(SETTINGS.displayName.minLength, `Nickname must be at least ${SETTINGS.displayName.minLength} characters.`)
    .max(SETTINGS.displayName.maxLength, `Nickname must be at most ${SETTINGS.displayName.maxLength} characters.`)
    .refine((val) => !/[<>]/.test(val), 'Nickname cannot contain < or >.'),
  pin: z
    .string()
    .trim()
    .min(6, 'PIN must be at least 6 digits/characters.')
    .max(32, 'PIN is too long.'),
});

/**
 * Hash nickname + PIN into a deterministic virtual email and strong password.
 */
function deriveVirtualCredentials(nickname: string, pin: string) {
  const normNick = nickname.trim().toLowerCase();
  const normPin = pin.trim();

  const userHash = createHash('sha256')
    .update(`ww:user:${normNick}:${normPin}`)
    .digest('hex')
    .slice(0, 24);

  const passHash = createHash('sha256')
    .update(`ww:pass:${normPin}:${normNick}:salt_ww_2026`)
    .digest('hex')
    .slice(0, 24);

  return {
    email: `p_${userHash}@game.local`,
    password: `Ww!${passHash}#9`,
  };
}

export async function POST(request: Request) {
  try {
    const parsed = await parseJsonBody(request, authSchema);
    if (!parsed.ok) return parsed.response;

    const { nickname, pin } = parsed.data;

    // 1. RATE LIMIT KHUSUS AUTH (Wajib jalan & TERPISAH dari DISABLE_RATE_LIMIT)
    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown-ip';

    const rateLimitIdentifier = `auth:${clientIp}:${nickname.toLowerCase()}`;
    const admin = createAdminClient();

    // Maksimal 10 percobaan per 60 detik per IP + Nickname
    const { data: rlData } = await admin.rpc('consume_rate_limit', {
      p_bucket: 'submitAction', // Menggunakan fungsi standard consume_rate_limit
      p_key: rateLimitIdentifier,
      p_limit: 10,
      p_window_seconds: 60,
    });

    const rl = rlData as { ok?: boolean; allowed?: boolean; remaining?: number } | null;
    if (rl && rl.allowed === false) {
      return tooManyRequests('Too many PIN attempts. Please wait 1 minute.', 60);
    }

    // 2. Derive deterministic credentials
    const { email, password } = deriveVirtualCredentials(nickname, pin);
    const supabase = await createServerClient();

    // 3. Try to sign in
    let signInResult = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    // 4. If user not found, create via admin API then sign in
    if (signInResult.error) {
      const { error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { displayName: nickname },
      });

      if (createError && !createError.message.includes('already registered')) {
        return apiError(400, 'auth_failed', 'Failed to initialize player account.');
      }

      // Retry sign in
      signInResult = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInResult.error) {
        return apiError(401, 'invalid_credentials', 'Incorrect PIN for this nickname.');
      }
    }

    const authUser = signInResult.data.user;
    return ok({
      ok: true,
      userId: authUser?.id,
      displayName: nickname,
    });
  } catch (err) {
    console.error('[auth-nickname-pin] error:', err);
    return apiError(500, 'internal_error', 'Authentication failed.');
  }
}
