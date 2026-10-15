import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockAdminRpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ rpc: mockAdminRpc }),
}));

import { POST } from '@/app/api/internal/pending-actions/recover/route';

describe('pending-action recovery endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PENDING_ACTION_SCHEDULER_SECRET = 'secret value';
    mockAdminRpc.mockResolvedValue({ data: 2, error: null });
  });

  afterEach(() => {
    delete process.env.PENDING_ACTION_SCHEDULER_SECRET;
  });

  it('requires a bearer token', async () => {
    const response = await POST(new Request('http://localhost/x', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('recovers expired actions when authorized', async () => {
    const response = await POST(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { authorization: 'Bearer secret value' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expired: 2 });
    expect(mockAdminRpc).toHaveBeenCalledWith('finalize_expired_pending_actions', { p_batch_size: 250 });
  });
});
