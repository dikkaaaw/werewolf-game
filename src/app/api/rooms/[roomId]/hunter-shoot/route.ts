import 'server-only';

import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { parseJsonBody } from '@/lib/server/api';
import { badRequest, ok, unauthorized } from '@/lib/server/api';
import { z } from 'zod';

const hunterShotSchema = z.object({ targetPlayerId: z.uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const parsed = await parseJsonBody(request, hunterShotSchema);
  if (!parsed.ok) return parsed.response;

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return unauthorized('Authentication required.');

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('apply_hunter_final_shot', {
    p_room_id: roomId,
    p_user_id: user.id,
    p_target_player_id: parsed.data.targetPlayerId,
  });

  if (error) return badRequest(error.message ?? 'Failed to submit Hunter shot.');
  const body = data as { ok?: boolean; error?: { code?: string; message?: string } } | null;
  if (!body?.ok) {
    return badRequest(body?.error?.message ?? 'Hunter shot is unavailable.');
  }

  return ok({ ok: true });
}
