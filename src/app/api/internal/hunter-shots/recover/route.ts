import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.SCHEDULER_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!expected || provided.length !== expected.length || timingSafeEqual(provided, expected) === false) {
    return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('expire_pending_hunter_final_shots', { p_room_id: null });
  if (error) {
    return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Recovery failed.' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return Response.json(data);
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
