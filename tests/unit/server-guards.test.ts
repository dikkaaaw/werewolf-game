import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockAdvanceRoomPhaseIfExpired = vi.fn();
const mockAdminRpc = vi.fn();
const mockAdminFrom = vi.fn();

// The snapshot route needs different table stubs per test, so the session
// client reads from a mutable holder rather than a fixed literal.
let sessionTables: Record<string, unknown> = {};
// Builds a self-returning query chain that resolves to a single row. Used to
// stub the session client's table reads.
const chainRow = (r: unknown): unknown => ({
  select: vi.fn(() => chainRow(r)),
  eq: vi.fn(() => chainRow(r)),
  single: vi.fn(async () => ({ data: r, error: null })),
  then: (res: (v: unknown) => unknown) => Promise.resolve({ data: r, error: null }).then(res),
});

const mockCreateServerClient = vi.fn(async () => ({
  auth: { getUser: mockGetUser },
  from: (t: string) => sessionTables[t],
}));

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...(args as [])),
  createAdminClient: () => ({ rpc: mockAdminRpc, from: mockAdminFrom }),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async (bucket: string, id: string) => mockCheckRateLimit(bucket, id)),
}));

vi.mock('@/lib/server/phase-advancement', () => ({
  advanceRoomPhaseIfExpired: vi.fn(async (roomId: string) =>
    mockAdvanceRoomPhaseIfExpired(roomId),
  ),
}));

import { GET as getRoomHandler } from '@/app/api/rooms/[roomId]/route';
import { GET as getMyRoleHandler } from '@/app/api/rooms/[roomId]/my-role/route';
import { POST as submitActionHandler } from '@/app/api/rooms/[roomId]/actions/route';
import { POST as castVoteHandler } from '@/app/api/rooms/[roomId]/votes/route';

const PLAYER = { id: 'player-id-1', display_name: 'Alice', seat_number: 1, is_alive: true };

function allow() {
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: new Date(Date.now() + 60000).toISOString(),
  });
}

function deny() {
  mockCheckRateLimit.mockResolvedValue({
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 30000).toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionTables = {};
  mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });
  mockAdvanceRoomPhaseIfExpired.mockResolvedValue(false);
  allow();
});

describe('Snapshot route — rate limiting', () => {
  function stubSnapshot() {
    const row = chainRow;
    const tables: Record<string, unknown> = {
      rooms: row({
        id: 'room-1',
        room_code: 'ABC234',
        status: 'lobby',
        phase: 'lobby',
        round_number: 0,
        phase_ends_at: null,
        max_players: 10,
        host_user_id: 'player-user-1',
        expires_at: null,
        state_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        settings: {},
      }),
      room_players: row([]),
    };
    sessionTables = tables;
  }

  it('checks the roomSnapshot bucket for the authenticated user', async () => {
    stubSnapshot();
    await getRoomHandler(new Request('http://localhost/api/rooms/room-1'), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('roomSnapshot', 'player-user-1');
  });

  it('returns 429 and does not read the room once the limit is hit', async () => {
    deny();
    const res = await getRoomHandler(new Request('http://localhost/api/rooms/room-1'), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(429);
    // No room data may be served once the caller is over budget.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('roomSnapshot', 'player-user-1');
  });

  it('does not rate limit an unauthenticated caller (401 first)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await getRoomHandler(new Request('http://localhost/api/rooms/room-1'), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('my-role route — rate limiting', () => {
  function stubMyRole() {
    mockAdminFrom
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: PLAYER, error: null }),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { role_key: 'seer', alignment: 'village' },
          error: null,
        }),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      });
  }

  it('checks the myRole bucket for the authenticated user', async () => {
    stubMyRole();
    await getMyRoleHandler(new Request('http://localhost/api/rooms/room-1/my-role'), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('myRole', 'player-user-1');
  });

  it('returns 429 without touching the secret tables once limited', async () => {
    deny();
    const res = await getMyRoleHandler(new Request('http://localhost/api/rooms/room-1/my-role'), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(429);
    // Crucially: player_secrets must not be queried at all.
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });
});

describe('Mutation routes — lazy phase advancement', () => {
  // The membership gate runs BEFORE advancement, and these tests are about
  // advancement — so the caller must be a member of room-1. Without this the
  // gate returns 404 and the advancement assertions cannot be reached.
  beforeEach(() => {
    sessionTables.rooms = chainRow({ id: 'room-1' });
  });

  const actionReq = () =>
    new Request('http://localhost/api/rooms/room-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'eliminate',
        targetPlayerId: '11111111-1111-4111-8111-111111111111',
      }),
    });

  const voteReq = () =>
    new Request('http://localhost/api/rooms/room-1/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPlayerId: '11111111-1111-4111-8111-111111111111' }),
    });

  it('advances an expired phase before submitting a night action', async () => {
    mockAdminRpc.mockResolvedValue({ data: { ok: true, roundNumber: 1 }, error: null });

    await submitActionHandler(actionReq(), { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(mockAdvanceRoomPhaseIfExpired).toHaveBeenCalledWith('room-1');
    // The authoritative RPC still runs afterwards to judge the action.
    expect(mockAdminRpc).toHaveBeenCalledWith(
      'submit_night_action',
      expect.objectContaining({ p_room_id: 'room-1' }),
    );
  });

  it('advances an expired phase before casting a vote', async () => {
    mockAdminRpc.mockResolvedValue({ data: { ok: true, roundNumber: 1 }, error: null });

    await castVoteHandler(voteReq(), { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(mockAdvanceRoomPhaseIfExpired).toHaveBeenCalledWith('room-1');
    expect(mockAdminRpc).toHaveBeenCalledWith(
      'cast_vote',
      expect.objectContaining({ p_room_id: 'room-1' }),
    );
  });

  it('still judges the action when advancement itself fails', async () => {
    // A transient error resolving the phase must not turn into a rejection the
    // player did not cause; the RPC remains authoritative either way.
    mockAdvanceRoomPhaseIfExpired.mockRejectedValue(new Error('resolver unavailable'));
    mockAdminRpc.mockResolvedValue({ data: { ok: true, roundNumber: 1 }, error: null });

    const res = await submitActionHandler(actionReq(), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalled();
  });

  it('does not advance before the caller is authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await submitActionHandler(actionReq(), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(401);
    expect(mockAdvanceRoomPhaseIfExpired).not.toHaveBeenCalled();
  });

  it('does not advance when the request body is invalid', async () => {
    const res = await submitActionHandler(
      new Request('http://localhost/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'teleport' }),
      }),
      { params: Promise.resolve({ roomId: 'room-1' }) },
    );

    expect(res.status).toBe(400);
    expect(mockAdvanceRoomPhaseIfExpired).not.toHaveBeenCalled();
  });

  it('still rejects a genuinely late action with the engine error', async () => {
    // The phase advanced, so the night action is now in the wrong phase. The
    // RPC decides — advancement must not paper over that.
    mockAdvanceRoomPhaseIfExpired.mockResolvedValue(true);
    mockAdminRpc.mockResolvedValue({
      data: { ok: false, error: { code: 'wrong_phase', message: 'Not the night phase.' } },
      error: null,
    });

    const res = await submitActionHandler(actionReq(), {
      params: Promise.resolve({ roomId: 'room-1' }),
    });

    expect(res.status).toBe(409);
  });
});