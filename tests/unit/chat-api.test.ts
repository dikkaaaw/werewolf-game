import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockClientFrom = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockClientFrom,
  })),
  createAdminClient: vi.fn(() => ({
    rpc: mockAdminRpc,
    from: mockAdminFrom,
  })),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async (b, id) => mockCheckRateLimit(b, id)),
}));

vi.mock('@/lib/server/auth', () => ({
  requireRoomAccess: vi.fn(async () => true),
}));

import { GET, POST } from '@/app/api/rooms/[roomId]/chat/route';

describe('Chat API Route — /api/rooms/[roomId]/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 20, resetAt: new Date().toISOString() });
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await GET(new Request('http://localhost/api'), { params: Promise.resolve({ roomId: 'r1' }) });
    expect(res.status).toBe(401);
  });

  it('allows alive players to send messages during day phase', async () => {
    const chain = (data: unknown) => ({
      select: vi.fn(() => chain(data)),
      eq: vi.fn(() => chain(data)),
      single: vi.fn(async () => ({ data, error: null })),
      insert: vi.fn(() => chain(data)),
    });

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'rooms') return chain({ status: 'in_progress', phase: 'day', round_number: 1 });
      if (table === 'room_players') return chain({ id: 'p1', is_alive: true, display_name: 'Budi' });
      if (table === 'game_chat_messages') return chain({ id: 'm1', message: 'Halo warga', created_at: new Date().toISOString() });
      return chain(null);
    });

    const res = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Halo warga' }),
      }),
      { params: Promise.resolve({ roomId: 'r1' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message.message).toBe('Halo warga');
  });

  it('forbids dead players from chatting', async () => {
    const chain = (data: unknown) => ({
      select: vi.fn(() => chain(data)),
      eq: vi.fn(() => chain(data)),
      single: vi.fn(async () => ({ data, error: null })),
    });

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'rooms') return chain({ status: 'in_progress', phase: 'day', round_number: 1 });
      if (table === 'room_players') return chain({ id: 'p1', is_alive: false, display_name: 'Ghost' });
      return chain(null);
    });

    const res = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Aku mati' }),
      }),
      { params: Promise.resolve({ roomId: 'r1' }) },
    );

    expect(res.status).toBe(403);
  });

  it('forbids chatting during the night phase', async () => {
    const chain = (data: unknown) => ({
      select: vi.fn(() => chain(data)),
      eq: vi.fn(() => chain(data)),
      single: vi.fn(async () => ({ data, error: null })),
    });

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'rooms') return chain({ status: 'in_progress', phase: 'night', round_number: 1 });
      return chain(null);
    });

    const res = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Halo serigala' }),
      }),
      { params: Promise.resolve({ roomId: 'r1' }) },
    );

    expect(res.status).toBe(403);
  });
});
