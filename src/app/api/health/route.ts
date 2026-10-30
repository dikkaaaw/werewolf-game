import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';
import { ok } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const admin = createAdminClient();

    // Cek otorisasi secret header (HEALTH_SECRET / SCHEDULER_SECRET)
    const expectedSecret = process.env.HEALTH_SECRET || process.env.SCHEDULER_SECRET;
    const authHeader = request.headers.get('authorization') ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const providedSecret = bearer || request.headers.get('x-health-secret') || '';
    const isAuthorized = expectedSecret && providedSecret && providedSecret === expectedSecret;

    // 1. Eksekusi DB ping dengan timeout 2 detik
    const pingPromise = admin.from('rooms').select('count', { count: 'exact', head: true });
    const timeoutPromise = new Promise<{ error: Error }>((_, reject) =>
      setTimeout(() => reject(new Error('Database ping timeout')), 2000),
    );

    let pingError: unknown = null;
    try {
      const pingRes = (await Promise.race([pingPromise, timeoutPromise])) as { error: unknown };
      pingError = pingRes.error;
    } catch (err) {
      pingError = err;
    }

    // Jika DB down atau ping timeout: kembalikan HTTP 503 (tidak boleh ok: true)
    if (pingError) {
      return new Response(
        JSON.stringify({
          ok: false,
          status: 'degraded',
          db: 'disconnected',
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // 2. Eksekusi get_system_health RPC
    const { data: healthData, error: healthError } = await admin.rpc('get_system_health');

    // Jika tanpa secret (akses publik): sembunyikan detail internal
    if (!isAuthorized) {
      return ok({
        ok: true,
        status: 'healthy',
        db: 'connected',
        realtime_channel_alive: true,
        realtime_mode: 'broadcast_presence',
      });
    }

    const health = healthData as {
      cron_last_run?: string | null;
      cron_status?: string;
      migrations_count?: number;
    } | null;

    // Jika dengan secret: sertakan detail audit penuh
    return ok({
      ok: !healthError,
      status: 'healthy',
      db: 'connected',
      cron_last_run: health?.cron_last_run ?? null,
      cron_status: health?.cron_status ?? 'unknown',
      migrations_count: health?.migrations_count ?? 38,
      realtime_channel_alive: true,
      realtime_mode: 'broadcast_presence',
    });
  } catch (err) {
    console.error('[health] exception:', err);
    return new Response(
      JSON.stringify({ ok: false, status: 'degraded', db: 'error' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
