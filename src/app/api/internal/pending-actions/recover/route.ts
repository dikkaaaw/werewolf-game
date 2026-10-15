import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.PENDING_ACTION_SCHEDULER_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!expected || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('finalize_expired_pending_actions', { p_batch_size: 250 });
  if (error) {
    return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Recovery failed.' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ expired: data ?? 0 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
