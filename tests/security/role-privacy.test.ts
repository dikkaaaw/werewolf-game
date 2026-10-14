import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();

/**
 * Whether the RLS-gated reads behave as if the caller IS a room member.
 * Flipping this to false is how the non-member authorization boundary is
 * expressed: the session client returns no room, exactly as RLS does in
 * production. See "refuses the snapshot" below.
 */
let mockCallerIsMember = true;
const mockAdminRpc = vi.fn();
const mockAdvanceRoomPhaseIfExpired = vi.fn();
const mockAdminFrom = vi.fn();

/**
 * The public snapshot needs each roster player's role_key to decide what may be
 * revealed, and `player_secrets` has zero RLS policies — so that read must use
 * the service role. These spies capture HOW it is called, which is the security
 * property: scoped to this room's roster, selecting role_key and nothing else.
 */
const mockSecretsFrom = vi.fn(() => {
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ player_id: 'player-1', role_key: 'werewolf' }], error: null }).then(resolve),
  };
  return builder;
});

function chain<T>(result: { data: T; error: null }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    single: vi.fn(async () => result),
    then: (resolve: (value: { data: T; error: null }) => unknown) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'rooms') {
        if (!mockCallerIsMember) {
          // RLS returns zero rows for a non-member, so `.single()` errors —
          // indistinguishable from "no such room", which is the point.
          return chain({ data: null as never, error: { code: 'PGRST116', message: 'no rows' } as never });
        }
        return chain({
          data: {
            id: 'room-1',
            room_code: 'ABC234',
            status: 'in_progress',
            phase: 'voting',
            round_number: 2,
            phase_ends_at: new Date(Date.now() + 60000).toISOString(),
            max_players: 10,
            host_user_id: 'user-1',
            expires_at: null,
            state_version: 7,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:05:00Z',
            settings: { winner: null },
          },
          error: null,
        });
      }
      if (table === 'room_players') {
        if (!mockCallerIsMember) {
          return chain({ data: [] as never, error: null });
        }
        return chain({
          data: [
            {
              id: 'player-1',
              user_id: 'user-1',
              display_name: 'Alice',
              seat_number: 1,
              is_alive: true,
              is_ready: true,
              death_cause: null,
              died_at: null,
              joined_at: '2026-01-01T00:00:00Z',
              last_seen_at: '2026-01-01T00:00:00Z',
              // Columns that must never be projected by the public snapshot.
              role_key: 'werewolf',
              alignment: 'werewolf',
              investigation_result: null,
            },
          ],
          error: null,
        });
      }
      if (table === 'game_votes') {
        return chain({
          data: [{ voter_player_id: 'player-1', target_player_id: 'player-2' }],
          error: null,
        });
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  })),
  createAdminClient: vi.fn(() => ({
    rpc: mockAdminRpc,
    from: vi.fn((table: string) => {
      if (table === 'player_secrets') return mockSecretsFrom();
      return mockAdminFrom(table);
    }),
  })),
}));

vi.mock('@/lib/server/phase-advancement', () => ({
  advanceRoomPhaseIfExpired: vi.fn(async (...args: unknown[]) => mockAdvanceRoomPhaseIfExpired(...args)),
}));

// The snapshot route is rate limited per account (RESOURCE-LIMITS §2), so the
// limiter must be stubbed alongside the Supabase clients.
const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async (bucket: string, identifier: string) => mockCheckRateLimit(bucket, identifier)),
}));

import { GET as getRoomHandler } from '@/app/api/rooms/[roomId]/route';

const SECRET_KEYS = [
  'roleKey',
  'role_key',
  'alignment',
  'secret',
  'secretId',
  'secret_id',
  'investigations',
  'investigation_result',
];

function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      collectKeys(nested, found);
    }
  }
  return found;
}

describe('Secret role privacy — public room snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallerIsMember = true;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  it('returns the room snapshot to an authenticated member', async () => {
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.room.roomCode).toBe('ABC234');
    expect(json.room.players).toHaveLength(1);
  });

  it('never exposes role, alignment, or Seer intel in the public snapshot', async () => {
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });
    const json = await res.json();

    const keys = collectKeys(json);
    for (const secret of SECRET_KEYS) {
      expect(keys).not.toContain(secret);
    }

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('werewolf"');
    expect(serialized).not.toContain('seer');
  });

  it('reads roles for the reveal rule with a tight, room-scoped, minimal select', async () => {
    mockSecretsFrom.mockClear();
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    // Reading role_key at all is necessary (player_secrets has zero RLS
    // policies, so the session client cannot see it) — but the read must be
    // constrained in three ways, and each is asserted here:
    //
    //   1. only player_secrets is touched, never a wider privileged read;
    //   2. it is filtered to THIS room's roster ids, so another room's players
    //      are structurally unreachable; and
    //   3. it selects role_key alone — never alignment or private state.
    expect(mockSecretsFrom).toHaveBeenCalledTimes(1);
    expect(mockSecretsFrom).toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();

    const builder = mockSecretsFrom.mock.results[0].value;
    expect(builder.select).toHaveBeenCalledWith('player_id, role_key');
    expect(builder.in).toHaveBeenCalledWith('player_id', ['player-1']);
  });

  it('withholds the role of a living player even though the secret was readable', async () => {
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });
    const json = await res.json();

    // The fixture player is alive and the room is in progress, so the reveal
    // rule must suppress the role even though the service read returned it.
    expect(json.room.players[0].revealedRole).toBeNull();
    expect(JSON.stringify(json)).not.toContain('werewolf');
  });

  it('refuses the snapshot to a non-member', async () => {
    mockCallerIsMember = false;
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(res.status).toBe(404);
    const json = await res.json();
    // The body must not confirm whether the room exists.
    expect(JSON.stringify(json)).not.toContain('ABC234');
    expect(JSON.stringify(json)).not.toContain('Alice');
  });

  it('does NOT run privileged phase advancement for a non-member', async () => {
    // This is the regression guard for the ordering fix. Advancement performs
    // service-role claim/resolve/commit work; if it ran before membership was
    // established, any client holding a room id could drive the state machine.
    mockCallerIsMember = false;
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(mockAdvanceRoomPhaseIfExpired).not.toHaveBeenCalled();
    // And nothing privileged ran at all.
    expect(mockSecretsFrom).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it('does NOT run privileged phase advancement for an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(res.status).toBe(401);
    expect(mockAdvanceRoomPhaseIfExpired).not.toHaveBeenCalled();
  });

  it('still runs phase advancement for an authenticated member', async () => {
    // Guards against "fixing" the ordering by deleting the lazy-advance call.
    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(res.status).toBe(200);
    expect(mockAdvanceRoomPhaseIfExpired).toHaveBeenCalledWith('room-1');
  });

  it('refuses the snapshot to unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const req = new Request('http://localhost:3000/api/rooms/room-1');
    const res = await getRoomHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });

    expect(res.status).toBe(401);
  });
});