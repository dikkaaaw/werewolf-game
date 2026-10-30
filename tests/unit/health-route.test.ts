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
        migrations_count: 38,
      },
      error: null,
    });
    mockAdminFrom.mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: null, count: 5, error: null }),
    });
  });

  it('returns safe public health info when called without secret header', async () => {
    const res = await healthHandler(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('connected');
    expect(body.status).toBe('healthy');
    // Internal audit metrics are hidden from unauthenticated callers
    expect(body.cron_last_run).toBeUndefined();
    expect(body.migrations_count).toBeUndefined();
  });

  it('returns full health metrics when called with valid health secret', async () => {
    process.env.HEALTH_SECRET = 'my-secret-token';
    const res = await healthHandler(
      new Request('http://localhost/api/health', {
        headers: { 'x-health-secret': 'my-secret-token' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cron_last_run).toBe('2026-10-30T12:00:00Z');
    expect(body.migrations_count).toBe(38);
    delete process.env.HEALTH_SECRET;
  });

  it('returns 503 degraded when database ping fails without secret header', async () => {
    mockAdminFrom.mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: null, error: new Error('DB connection refused') }),
    });
    const res = await healthHandler(new Request('http://localhost/api/health'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('degraded');
  });
});
