import { createBrowserClient } from '@supabase/ssr';

import { publicEnv } from '@/lib/env';

/**
 * Browser Supabase client.
 *
 * Uses the anon key only. The anon key is not a secret — Row Level Security is
 * what protects the data, which is why the private tables have no policies
 * (see supabase/migrations/0002_rls.sql).
 */
export function createClient() {
  const env = publicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
