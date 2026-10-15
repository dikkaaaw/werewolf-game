import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
  createAdminClient: vi.fn(() => ({ rpc: mockAdminRpc })),
}));

import { POST as hunterShot } from '@/app/api/rooms/[roomId]/hunter-shoot/route';
import { POST as hunterRecover } from '@/app/api/internal/hunter-shots/recover/route';

function request(body: unknown) {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer scheduler-secret' },
    body: JSON.stringify(body),
  });
}

describe('Hunter endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockAdminRpc.mockResolvedValue({ data: { ok: true, expired: 1 }, error: null });
    process.env.SCHEDULER_SECRET = 'scheduler-secret';
  });

  afterEach(() => {
    delete process.env.SCHEDULER_SECRET;
  });

  it('routes an authenticated Hunter shot through the authoritative RPC', async () => {
    const response = await hunterShot(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetPlayerId: '11111111-1111-4111-8111-111111111111' }),
      }),
      { params: Promise.resolve({ roomId: 'room-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledWith('apply_hunter_final_shot', {
      p_room_id: 'room-1',
      p_user_id: 'user-1',
      p_target_player_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('requires the scheduler secret for timeout recovery', async () => {
    const denied = await hunterRecover(
      new Request('http://localhost/api', { method: 'POST' }),
    );
    expect(denied.status).toBe(401);
    expect(mockAdminRpc).not.toHaveBeenCalled();

    const allowed = await hunterRecover(request({}));
    expect(allowed.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledWith('expire_pending_hunter_final_shots', {
      p_room_id: null,
    });
  });
});
