import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockAdminRpc = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    rpc: mockAdminRpc,
    from: mockAdminFrom,
  }),
}));

import { GET as healthHandler } from '@/app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminRpc.mockResolvedValue({
      data: {
        ok: true,
        db: 'connected',
        cron_last_run: '2026-10-30T12:00:00Z',
        cron_status: 'succeeded',
        migrations_count: 36,
      },
      error: null,
    });
    mockAdminFrom.mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: null, count: 5, error: null }),
    });
  });

  it('returns 200 with full health metrics when services are operational', async () => {
    const res = await healthHandler();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('connected');
    expect(body.cron_last_run).toBe('2026-10-30T12:00:00Z');
    expect(body.migrations_count).toBe(36);
    expect(body.realtime_channel_alive).toBe(true);
    expect(body.realtime_mode).toBe('broadcast_presence');
  });

  it('handles database RPC errors gracefully with 500', async () => {
    mockAdminRpc.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout' },
    });
    const res = await healthHandler();
    expect(res.status).toBe(500);
  });
});
