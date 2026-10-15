import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminFrom = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
  })),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn((bucket: string, id: string) => mockCheckRateLimit(bucket, id)),
}));

import { GET as getMyRoleHandler } from '@/app/api/rooms/[roomId]/my-role/route';

/**
 * Builds the chainable query stub the route uses, and records every filter so
 * the tests can assert the privileged reads stay scoped to the caller's own
 * player row within the requested room.
 */
function queryReturning(row: unknown, error: unknown = null) {
  const single = vi.fn().mockResolvedValue({ data: row, error });
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  // Mirrors the real builder: `.eq()` returns a chain that still exposes both
  // `.eq()` and the terminal `.single()`.
  const eq: ReturnType<typeof vi.fn> = vi.fn();
  eq.mockReturnValue({ eq, single, maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const builder = { select, eq, single, maybeSingle };
  const from = vi.fn().mockReturnValue(builder);
  return { builder, from };
}

/**
 * Builders for the two lookups that answer "did I already act this round?".
 * Both are optional: a player who has not acted matches no row.
 */
function nightActionMocks(roundNumber: number, action: unknown = null) {
  const actionQuery = queryReturning(action);
  return {
    room: queryReturning({ round_number: roundNumber }).builder,
    action: actionQuery.builder,
    actionQuery,
  };
}

function req() {
  return new Request('http://localhost:3000/api/rooms/room-123/my-role');
}

describe('GET /api/rooms/[roomId]/my-role — private role isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  it('rejects an unauthenticated caller with 401 and never queries the database', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(401);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it('returns 404 for an authenticated user who is not in the room, without reading secrets', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'outsider' } }, error: null });
    // Membership lookup matches zero rows -> PGRST116, exactly as Supabase
    // reports it for `.single()` on an empty result.
    mockAdminFrom.mockReturnValue(queryReturning(null, { code: 'PGRST116' }).builder);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(404);
    // Only the membership query ran; player_secrets was never reached.
    expect(mockAdminFrom).toHaveBeenCalledTimes(1);
    expect(mockAdminFrom).toHaveBeenCalledWith('room_players');
  });

  it('returns 404 when the member has no assigned role yet', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });
    mockAdminFrom.mockReturnValueOnce(
      queryReturning({ id: 'player-id-1', seat_number: 2, display_name: 'Alice' }).builder,
    );
    // player_secrets row absent (pre-game / role not yet written).
    mockAdminFrom.mockReturnValueOnce(queryReturning(null, { code: 'PGRST116' }).builder);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(404);
    expect(mockAdminFrom).toHaveBeenCalledTimes(2);
    expect(mockAdminFrom).toHaveBeenNthCalledWith(2, 'player_secrets');
  });

  it('returns the caller’s own role, scoped to their player id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });

    const member = queryReturning({
      id: 'player-id-1',
      seat_number: 2,
      display_name: 'Alice',
      is_alive: true,
    });
    const secret = queryReturning({ role_key: 'seer', alignment: 'village' });
    // The history query ends in `.order()` rather than `.single()`.
    const order = vi.fn().mockResolvedValue({
      data: [{ round_number: 1, result_payload: { targetPlayerId: 'player-id-9' } }],
      error: null,
    });
    const historyEq: ReturnType<typeof vi.fn> = vi.fn();
    historyEq.mockReturnValue({ eq: historyEq, order });
    const results = { select: vi.fn().mockReturnValue({ eq: historyEq }), historyEq };

      const night = nightActionMocks(3);
    mockAdminFrom
      .mockReturnValueOnce(member.builder)
      .mockReturnValueOnce(secret.builder)
      .mockReturnValueOnce(results)
      .mockReturnValueOnce(night.room)
      .mockReturnValueOnce(night.action);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    const json = await res.json();
    expect(json).toEqual({
      playerId: 'player-id-1',
      displayName: 'Alice',
      seatNumber: 2,
      roleKey: 'seer',
      alignment: 'village',
      // No night action recorded yet, so the UI keeps offering the buttons.
      nightAction: null,
      investigations: [{ roundNumber: 1, result: { targetPlayerId: 'player-id-9' } }],
    });

    // Secrets are looked up by the CALLER'S player id, never a client-supplied one.
    expect(member.builder.eq).toHaveBeenCalledWith('room_id', 'room-123');
    expect(member.builder.eq).toHaveBeenCalledWith('user_id', 'player-user-1');
    expect(secret.builder.eq).toHaveBeenCalledWith('player_id', 'player-id-1');
  });

  it('reports the caller\'s own night action so the UI can lock the buttons', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 90_000 });

    const member = queryReturning({
      id: 'player-id-1',
      seat_number: 1,
      display_name: 'Alice',
      is_alive: true,
    });
    const secret = queryReturning({ role_key: 'guardian_angel', alignment: 'village' });
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const historyEq: ReturnType<typeof vi.fn> = vi.fn();
    historyEq.mockReturnValue({ eq: historyEq, order });
    const results = { select: vi.fn().mockReturnValue({ eq: historyEq }), historyEq };

    const night = nightActionMocks(4, {
      action_type: 'protect',
      target_player_id: 'player-id-2',
    });
    mockAdminFrom
      .mockReturnValueOnce(member.builder)
      .mockReturnValueOnce(secret.builder)
      .mockReturnValueOnce(results)
      .mockReturnValueOnce(night.room)
      .mockReturnValueOnce(night.action);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.nightAction).toEqual({ actionType: 'protect', targetPlayerId: 'player-id-2' });
    // Scoped to the caller's own player id, never a client-supplied one.
    expect(night.actionQuery.builder.eq).toHaveBeenCalledWith('actor_player_id', 'player-id-1');
    expect(night.actionQuery.builder.eq).toHaveBeenCalledWith('round_number', 4);
  });

  it('cannot be steered toward another player: every id filter is session-derived', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });

    const member = queryReturning({ id: 'player-id-1', seat_number: 1, display_name: 'Alice' });
    const secret = queryReturning({ role_key: 'werewolf', alignment: 'werewolf' });
    // The history query ends in `.order()` rather than `.single()`.
    const historyEq = vi.fn();
    historyEq.mockReturnValue({
      eq: historyEq,
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    const results = { select: vi.fn().mockReturnValue({ eq: historyEq }), historyEq };

      const night = nightActionMocks(3);
    mockAdminFrom
      .mockReturnValueOnce(member.builder)
      .mockReturnValueOnce(secret.builder)
      .mockReturnValueOnce(results)
      .mockReturnValueOnce(night.room)
      .mockReturnValueOnce(night.action);

    // The request carries no body and no query string: there is no channel by
    // which a caller could name a different player.
    const res = await getMyRoleHandler(
      new Request('http://localhost:3000/api/rooms/room-123/my-role'),
      { params: Promise.resolve({ roomId: 'room-123' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerId).toBe('player-id-1');

    // The membership query keys on the SESSION user id, and the secrets query
    // keys on the player id that membership returned. Both are server-derived.
    expect(member.builder.eq).toHaveBeenCalledWith('user_id', 'player-user-1');
    expect(member.builder.eq).not.toHaveBeenCalledWith('user_id', 'victim-user-id');
    expect(secret.builder.eq).toHaveBeenCalledWith('player_id', 'player-id-1');
    expect(secret.builder.eq).not.toHaveBeenCalledWith('player_id', 'victim-player-id');

    // And the investigation history is pinned to the caller, not the room.
    const historyFilterEq = results.historyEq;
    expect(historyFilterEq).toHaveBeenCalledWith('actor_player_id', 'player-id-1');
    expect(historyFilterEq).not.toHaveBeenCalledWith('actor_player_id', 'victim-player-id');
  });

  it('does not leak internals when a database query rejects', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });
    mockAdminFrom.mockImplementation(() => {
      throw new Error('connection to service_role pool failed');
    });

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('service_role');
    expect(body).not.toContain('connection to');
  });

  it('rate limits per authenticated account', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 5000).toISOString(),
    });

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('myRole', 'player-user-1');
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });
});
describe('GET /api/rooms/[roomId]/my-role — private Hunter action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  function rosterQuery(rows: unknown[]) {
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    };
  }

  it('exposes the pending action and eligible targets only to the owning Hunter', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'hunter-user-1' } }, error: null });

    const member = queryReturning({
      id: 'hunter-player-1',
      seat_number: 1,
      display_name: 'Hunter',
      is_alive: false,
      prompt: { type: 'hunter_final_shot' },
      prompt_deadline_at: '2026-01-03T00:00:30.000Z',
    });
    const secret = queryReturning({ role_key: 'hunter', alignment: 'village' });

    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const historyEq: ReturnType<typeof vi.fn> = vi.fn();
    historyEq.mockReturnValue({ eq: historyEq, order });
    const results = { select: vi.fn().mockReturnValue({ eq: historyEq }), historyEq };

    const night = nightActionMocks(4);

    const roster = rosterQuery([
      { id: 'hunter-player-1', display_name: 'Hunter', is_alive: false },
      { id: 'player-id-2', display_name: 'Bob', is_alive: true },
      { id: 'player-id-3', display_name: 'Carol', is_alive: false },
    ]);

    mockAdminFrom
      .mockReturnValueOnce(member.builder)
      .mockReturnValueOnce(secret.builder)
      .mockReturnValueOnce(results)
      .mockReturnValueOnce(night.room)
      .mockReturnValueOnce(night.action)
      .mockReturnValueOnce(roster);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    const json = await res.json();
    expect(json.roleKey).toBe('hunter');
    expect(json.hunterAction).toEqual({
      deadlineAt: '2026-01-03T00:00:30.000Z',
      targets: [
        { id: 'player-id-2', displayName: 'Bob' },
      ],
    });
    expect(json.hunterAction.targets.some((t: { id: string }) => t.id === 'player-id-3')).toBe(false);
  });

  it('does not expose a pending action when the player has no prompt', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'hunter-user-1' } }, error: null });

    const member = queryReturning({
      id: 'hunter-player-1',
      seat_number: 1,
      display_name: 'Hunter',
      is_alive: false,
      prompt: null,
      prompt_deadline_at: null,
    });
    const secret = queryReturning({ role_key: 'hunter', alignment: 'village' });

    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const historyEq: ReturnType<typeof vi.fn> = vi.fn();
    historyEq.mockReturnValue({ eq: historyEq, order });
    const results = { select: vi.fn().mockReturnValue({ eq: historyEq }), historyEq };

    const night = nightActionMocks(4);

    mockAdminFrom
      .mockReturnValueOnce(member.builder)
      .mockReturnValueOnce(secret.builder)
      .mockReturnValueOnce(results)
      .mockReturnValueOnce(night.room)
      .mockReturnValueOnce(night.action);

    const res = await getMyRoleHandler(req(), {
      params: Promise.resolve({ roomId: 'room-123' }),
    });

    const json = await res.json();
    expect('hunterAction' in json).toBe(false);
  });
});
