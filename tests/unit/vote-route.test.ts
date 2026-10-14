import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
const ROOM = 'room-1';

// The membership gate reads through the session client; a self-returning
// chain is enough because requireRoomAccess is mocked separately.
const chainRow = (r: unknown): unknown => ({
  select: vi.fn(() => chainRow(r)),
  eq: vi.fn(() => chainRow(r)),
  single: vi.fn(async () => ({ data: r, error: null })),
  then: (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: r, error: null }).then(res),
});

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: () => chainRow({ id: ROOM }),
  })),
  createAdminClient: vi.fn(() => ({ rpc: mockAdminRpc })),
}));

const mockRequireRoomAccess = vi.fn(async () => true);
vi.mock('@/lib/server/auth', () => ({
  requireRoomAccess: vi.fn((...a: unknown[]) => mockRequireRoomAccess(...(a as []))),
}));

const mockCheckRateLimit = vi.fn(async () => ({
  allowed: true,
  remaining: 10,
  resetAt: new Date(Date.now() + 60_000).toISOString(),
}));
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn((...a: unknown[]) => mockCheckRateLimit(...(a as []))),
}));

vi.mock('@/lib/server/phase-advancement', () => ({
  advanceRoomPhaseIfExpired: vi.fn(async () => false),
}));

import { POST as castVoteHandler } from '@/app/api/rooms/[roomId]/votes/route';

const OTHER_TARGET = '22222222-2222-4222-8222-222222222222';

function post(body: unknown) {
  return new Request(`http://localhost:3000/api/rooms/${ROOM}/votes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const call = () => castVoteHandler(post({ targetPlayerId: OTHER_TARGET }), { params: Promise.resolve({ roomId: ROOM }) });

describe('POST /api/rooms/[roomId]/votes — authorization and forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRoomAccess.mockResolvedValue(true);
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  it('rejects an unauthenticated caller with 401 before touching the RPC', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await call();

    expect(res.status).toBe(401);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('rejects a non-member with 404 without disclosing room existence', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'stranger' } }, error: null });
    mockRequireRoomAccess.mockResolvedValue(false);

    const res = await call();

    expect(res.status).toBe(404);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('rate limits per account and does not reach the RPC', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'voter' } }, error: null });
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const res = await call();

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('submitVote', 'voter');
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('forwards the SESSION user id, never a client-supplied one', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-voter' } }, error: null });
    mockAdminRpc.mockResolvedValue({ data: { ok: true, roundNumber: 2 }, error: null });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledWith('cast_vote', {
      p_room_id: ROOM,
      p_user_id: 'session-voter',
      p_target_player_id: OTHER_TARGET,
    });
    // The body carries no user id field at all.
    expect(mockAdminRpc.mock.calls[0][1]).not.toHaveProperty('p_voter_user_id');
  });

  // Each of these is enforced authoritatively in the cast_vote RPC
  // (migration 0003). The route's job is to map the code onto the shared
  // status contract in `mapEngineError` and never report a rejected vote as a
  // success.
  //
  // `expectedCode` is what the shared helpers actually emit: `forbidden()`
  // and `conflict()` normalise to their own codes, so the engine code is only
  // echoed when the mapping routes to `apiError(status, code, message)`.
  const rpcRejections: Array<[code: string, message: string, status: number, expectedCode: string]> = [
    ['vote_for_self', 'You cannot vote for yourself.', 400, 'vote_for_self'],
    ['target_dead', 'That player has been eliminated.', 400, 'target_dead'],
    ['player_not_alive', 'Eliminated players cannot vote.', 400, 'player_not_alive'],
    ['target_not_in_room', 'That player is not in this room.', 404, 'not_found'],
    ['not_a_member', 'You are not in this room.', 403, 'forbidden'],
    ['not_voting_phase', 'Voting is not open.', 409, 'not_voting_phase'],
    ['phase_expired', 'Voting has ended.', 409, 'phase_expired'],
  ];

it.each(rpcRejections)(
    'surfaces %s as HTTP %i and never as a successful vote',
    async (code, message, status, expectedCode) => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'session-voter' } }, error: null });
      mockAdminRpc.mockResolvedValue({
        data: { ok: false, error: { code, message } },
        error: null,
      });

      const res = await call();
      const json = await res.json();

      expect(res.status).toBe(status);
      expect(json.error.code).toBe(expectedCode);
      expect(json.error.message).toBe(message);
      expect(json.ok).toBeUndefined();
    },
  );

  it('does not report success when the RPC itself errors', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { user: null, id: 'voter' } } as never, error: null });
    mockAdminRpc.mockResolvedValue({ data: null, error: { message: 'transport failure' } });

    const res = await call();

    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBeUndefined();
  });

  it('allows re-voting: a changed vote is forwarded, not blocked', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-voter' } }, error: null });
    mockAdminRpc.mockResolvedValue({ data: { ok: true, roundNumber: 2 }, error: null });

    const first = await castVoteHandler(
      post({ targetPlayerId: OTHER_TARGET }),
      { params: Promise.resolve({ roomId: ROOM }) },
    );
    const second = await castVoteHandler(
      post({ targetPlayerId: '33333333-3333-4333-8333-333333333333' }),
      { params: Promise.resolve({ roomId: ROOM }) },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Two distinct calls => the route does not dedupe; the RPC's
    // ON CONFLICT (room_id, round_number, voter_player_id) updates in place.
    expect(mockAdminRpc).toHaveBeenCalledTimes(2);
    expect(mockAdminRpc.mock.calls[1][1]).toMatchObject({
      p_target_player_id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('rejects a malformed body before reaching the RPC', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-voter' } }, error: null });

    const res = await castVoteHandler(
      new Request(`http://localhost:3000/api/rooms/${ROOM}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPlayerId: 'not-a-uuid' }),
      }),
      { params: Promise.resolve({ roomId: ROOM }) },
    );

    expect(res.status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });
});