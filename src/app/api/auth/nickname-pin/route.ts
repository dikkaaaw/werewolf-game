import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
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
    .min(8, 'PIN/Passphrase must be at least 8 alphanumeric characters.')
    .max(64, 'PIN/Passphrase is too long.'),
});

export async function POST(request: Request) {
  try {
    const parsed = await parseJsonBody(request, authSchema);
    if (!parsed.ok) return parsed.response;

    const { nickname, pin } = parsed.data;

    // 1. IP-based request throttling (terpisah & kebal terhadap DISABLE_RATE_LIMIT)
    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown-ip';

    const admin = createAdminClient();

    // Maksimal 15 request per IP per 60 detik (mencegah DoS connection)
    const { data: ipRl } = await admin.rpc('consume_rate_limit', {
      p_bucket: 'submitAction',
      p_key: `auth_ip:${clientIp}`,
      p_limit: 15,
      p_window_seconds: 60,
    });
    const ipParsed = ipRl as { allowed?: boolean } | null;
    if (ipParsed && ipParsed.allowed === false) {
      return tooManyRequests('Too many requests from this network. Please wait 1 minute.', 60);
    }

    // 2. Verifikasi Kredensial via RPC (dengan Bcrypt & Exponential Backoff per akun)
    const { data: verifyData, error: verifyError } = await admin.rpc('verify_player_credentials', {
      p_nickname: nickname,
      p_pin: pin,
    });

    if (verifyError) {
      return apiError(500, 'auth_error', 'Database verification failed.');
    }

    const res = verifyData as {
      ok: boolean;
      found: boolean;
      code?: string;
      message?: string;
      retry_after?: number;
      user_id?: string;
      email?: string;
    };

    // Jika akun sedang terkunci karena salah PIN berulang kali
    if (!res.ok && res.code === 'account_locked') {
      return tooManyRequests(res.message ?? 'Akun terkunci sementara.', res.retry_after ?? 60);
    }

    // Jika PIN salah
    if (!res.ok && res.code === 'invalid_pin') {
      return apiError(401, 'invalid_credentials', res.message ?? 'PIN salah untuk nickname ini.', {
        retryAfter: res.retry_after,
      });
    }

    const supabase = await createServerClient();
    let userEmail = res.email;
    let userId = res.user_id;

    // 3. User Baru: Daftarkan akun baru dengan UUID acak murni
    if (res.ok && !res.found) {
      const newRandomUuid = randomUUID();
      const internalEmail = `player_${randomBytes(12).toString('hex')}@werewolf.local`;
      const initialPassword = `Ww_${randomBytes(24).toString('hex')}!#`;

      const { data: newUser, error: createError } = await admin.auth.admin.createUser({
        id: newRandomUuid,
        email: internalEmail,
        password: initialPassword,
        email_confirm: true,
        user_metadata: { displayName: nickname },
      });

      if (createError || !newUser?.user) {
        return apiError(500, 'auth_failed', 'Gagal membuat identitas pemain baru.');
      }

      userId = newUser.user.id;
      userEmail = internalEmail;

      // Simpan kredensial bcrypt di player_credentials
      const { data: regData, error: regError } = await admin.rpc('register_player_credentials', {
        p_user_id: userId,
        p_nickname: nickname,
        p_pin: pin,
      });

      if (regError || !(regData as { ok?: boolean })?.ok) {
        // Rollback created user on credential registration failure
        await admin.auth.admin.deleteUser(userId);
        return apiError(409, 'nickname_taken', 'Nickname sudah digunakan oleh pemain lain.');
      }

      // Login untuk issue cookie sesi browser
      const loginRes = await supabase.auth.signInWithPassword({
        email: internalEmail,
        password: initialPassword,
      });

      if (loginRes.error) {
        return apiError(500, 'session_failed', 'Gagal mengaktifkan sesi login.');
      }
    } else if (res.ok && res.found && userId && userEmail) {
      // 4. User Lama: Reclaim sesi dengan ephemeral password reset
      const ephemeralPassword = `Ww_${randomBytes(24).toString('hex')}!#`;

      const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
        password: ephemeralPassword,
        email_confirm: true,
      });

      if (updateError) {
        return apiError(500, 'session_failed', 'Gagal memperbarui sesi pemain.');
      }

      // Login untuk issue cookie sesi browser ke user yang sama
      const loginRes = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: ephemeralPassword,
      });

      if (loginRes.error) {
        return apiError(500, 'session_failed', 'Gagal mengaktifkan sesi login.');
      }
    }

    return ok({
      ok: true,
      displayName: nickname,
    });
  } catch {
    // Tidak pernah mencetak PIN atau user_id mentah ke log console
    console.error('[auth-nickname-pin] internal authentication exception occurred');
    return apiError(500, 'internal_error', 'Authentication failed.');
  }
}
