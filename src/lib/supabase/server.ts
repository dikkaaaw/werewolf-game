import 'server-only';

import { createServerClient as createSupabaseServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { publicEnv, serverEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Server Supabase clients.
 *
 * Two distinct clients, and the distinction matters:
 *
 *  - `createServerClient()` — the *session* client. It runs as the signed-in
 *    user via their cookies, so RLS applies. Use it for anything a player is
 *    allowed to read or do directly.
 *
 *  - `createAdminClient()` — the *service role* client. It BYPASSES RLS. Use
 *    it only inside server code that has already authenticated the caller and
 *    verified they own the row being touched.
 *
 * This module is `server-only`: importing it from a component is a build error,
 * which is what stops the service-role key from ever reaching the browser.
 */

/** Session-scoped client. RLS applies. Safe for Server Components and handlers. */
export async function createServerClient() {
  const env = publicEnv();
  const cookieStore = await cookies();

  return createSupabaseServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        // Next 16: cookies() is async and only writable in a Route Handler or
        // Server Action, never in a Server Component.
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component, which cannot mutate cookies.
            // Safe to ignore: the middleware/proxy refreshes the session.
          }
        },
      },
    },
  );
}

let cachedAdminClient: SupabaseClient<Database> | undefined;

/**
 * Service-role client. BYPASSES ROW LEVEL SECURITY.
 *
 * Every caller MUST have already authenticated the session and verified
 * ownership. Never pass a `player_id` straight from a request body in here.
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (!cachedAdminClient) {
    const env = serverEnv();
    cachedAdminClient = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          // The service role is not a real login; never persist a session.
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  }
  return cachedAdminClient;
}
