import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLimit = vi.fn();
const mockLte = vi.fn(() => ({ limit: mockLimit }));
const mockEq = vi.fn(() => ({ lte: mockLte }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

const mockAdvance = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

vi.mock('@/lib/server/phase-advancement', () => ({
  advanceRoomPhaseIfExpired: (roomId: string) => mockAdvance(roomId),
}));

import { POST as advanceCron } from '@/app/api/cron/advance/route';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/advance', { method: 'POST', headers });
}

describe('POST /api/cron/advance', () => {
  const secret = 'scheduler-secret-that-is-long-enough';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCHEDULER_SECRET = secret;
    mockLimit.mockResolvedValue({ data: [], error: null });
    mockAdvance.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.SCHEDULER_SECRET;
  });

  it('rejects a request with no secret', async () => {
    const res = await advanceCron(request());
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await advanceCron(request({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('accepts the x-cron-secret header as well as the bearer token', async () => {
    const res = await advanceCron(request({ 'x-cron-secret': secret }));
    expect(res.status).toBe(200);
  });

  it('advances every due in-progress room through the existing tick', async () => {
    mockLimit.mockResolvedValue({
      data: [{ id: 'room-1' }, { id: 'room-2' }],
      error: null,
    });
    mockAdvance.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await advanceCron(request({ authorization: `Bearer ${secret}` }));
    const body = (await res.json()) as {
      ok: boolean;
      scanned: number;
      advanced: string[];
    };

    expect(res.status).toBe(200);
    expect(body.scanned).toBe(2);
    expect(body.advanced).toEqual(['room-1']);
    expect(mockAdvance).toHaveBeenNthCalledWith(1, 'room-1');
    expect(mockAdvance).toHaveBeenNthCalledWith(2, 'room-2');
  });

  it('returns 500 when the due-room query fails, without advancing anything', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await advanceCron(request({ authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(500);
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});
