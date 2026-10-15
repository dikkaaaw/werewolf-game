import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('advanceRoomPhaseIfExpired — tick_room RPC contract', () => {
  beforeEach(() => vi.clearAllMocks());

  async function run(mockRpc: ReturnType<typeof vi.fn>) {
    vi.doMock('@/lib/supabase/server', () => ({
      createAdminClient: vi.fn(() => ({ rpc: mockRpc })),
    }));
    vi.resetModules();
    const { advanceRoomPhaseIfExpired } = await import('@/lib/server/phase-advancement');
    return advanceRoomPhaseIfExpired('room-1');
  }

  it('returns true when tick_room reports advanced: true', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { ok: true, advanced: true, nextPhase: 'day' },
      error: null,
    });
    const advanced = await run(mockRpc);
    expect(advanced).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('tick_room', { p_room_id: 'room-1' });
  });

  it('returns false when tick_room reports advanced: false', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: { ok: true, advanced: false, reason: 'not_expired' },
      error: null,
    });
    const advanced = await run(mockRpc);
    expect(advanced).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith('tick_room', { p_room_id: 'room-1' });
  });

  it('returns false when tick_room returns an RPC error', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'connection failure' },
    });
    const advanced = await run(mockRpc);
    expect(advanced).toBe(false);
  });

  it('returns false when the client throws an exception', async () => {
    const mockRpc = vi.fn().mockRejectedValue(new Error('network crash'));
    const advanced = await run(mockRpc);
    expect(advanced).toBe(false);
  });
});
