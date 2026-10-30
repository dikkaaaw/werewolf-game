import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';
import { apiError, ok } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const admin = createAdminClient();

    // 1. Eksekusi get_system_health RPC
    const { data, error } = await admin.rpc('get_system_health');

    if (error) {
      return apiError(500, 'db_error', 'Health check RPC failed', { detail: error.message });
    }

    const healthData = data as {
      ok?: boolean;
      db?: string;
      cron_last_run?: string | null;
      cron_status?: string;
      migrations_count?: number;
    } | null;

    // 2. Cek status Realtime publication di public schema
    const { error: pubError } = await admin
      .from('rooms')
      .select('count', { count: 'exact', head: true });

    return ok({
      ok: healthData?.ok ?? true,
      db: healthData?.db ?? 'connected',
      cron_last_run: healthData?.cron_last_run ?? null,
      cron_status: healthData?.cron_status ?? 'unknown',
      migrations_count: healthData?.migrations_count ?? 0,
      realtime_channel_alive: !pubError,
      realtime_mode: 'broadcast_presence',
    });
  } catch (err) {
    console.error('[health] exception:', err);
    return apiError(500, 'internal_error', 'Health check failed.');
  }
}
