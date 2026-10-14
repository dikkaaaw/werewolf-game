import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminFrom = vi.fn();
const mockAdminRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
    rpc: mockAdminRpc,
  })),
}));

// my-role is rate limited per account (RESOURCE-LIMITS §2).
const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async (bucket: string, identifier: string) => mockCheckRateLimit(bucket, identifier)),
}));

import { POST as toggleReadyHandler } from '@/app/api/rooms/[roomId]/ready/route';
import { POST as startGameHandler } from '@/app/api/rooms/[roomId]/start/route';
import { GET as getMyRoleHandler } from '@/app/api/rooms/[roomId]/my-role/route';

describe('Ready System & Start Game Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  describe('POST /api/rooms/[roomId]/ready', () => {
    it('returns 401 if caller is unauthenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready: true }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(401);
    });

    it('rejects toggle if room is not in lobby status', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', status: 'in_progress' },
          error: null,
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready: true }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('game_already_started');
    });

    it('updates ready state for verified session user only', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'verified-user-1' } }, error: null });

      // 1. Room check
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', status: 'lobby' },
          error: null,
        }),
      });

      // 2. Player check
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation(function (this: unknown, col: string, val: string) {
          if (col === 'user_id') expect(val).toBe('verified-user-1');
          return this;
        }),
        single: vi.fn().mockResolvedValue({
          data: { id: 'player-1', seat_number: 1, is_alive: true },
          error: null,
        }),
      });

      // 3. Update player ready state
      const mockUpdate = vi.fn().mockReturnThis();
      mockAdminFrom.mockReturnValueOnce({
        update: mockUpdate,
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      // 4. Update room last_activity
      mockAdminFrom.mockReturnValueOnce({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isReady: true }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, isReady: true, ready: true, playerId: 'player-1' });
      expect(mockUpdate).toHaveBeenCalledWith({ is_ready: true });
    });

    it('supports unready (isReady: false) transition for verified session user', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'verified-user-1' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', status: 'lobby' },
          error: null,
        }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation(function (this: unknown, col: string, val: string) {
          if (col === 'user_id') expect(val).toBe('verified-user-1');
          return this;
        }),
        single: vi.fn().mockResolvedValue({
          data: { id: 'player-1', seat_number: 1, is_alive: true },
          error: null,
        }),
      });

      const mockUpdate = vi.fn().mockReturnThis();
      mockAdminFrom.mockReturnValueOnce({
        update: mockUpdate,
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      mockAdminFrom.mockReturnValueOnce({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isReady: false }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, isReady: false, ready: false, playerId: 'player-1' });
      expect(mockUpdate).toHaveBeenCalledWith({ is_ready: false });
    });

    it('does not allow updating another player status (scoped to user.id)', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'attacker-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', status: 'lobby' },
          error: null,
        }),
      });

      // Attacker not found as member
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Not found' },
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isReady: true }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.message).toContain('not a member');
    });

    it('returns 400 when database update fails and does not claim false success', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'verified-user-1' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', status: 'lobby' },
          error: null,
        }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'player-1', seat_number: 1, is_alive: true },
          error: null,
        }),
      });

      // DB update fails
      mockAdminFrom.mockReturnValueOnce({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: { message: 'Database connection failed' } }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isReady: true }),
      });

      const res = await toggleReadyHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toBe('Database connection failed');
    });
  });

  describe('POST /api/rooms/[roomId]/start', () => {
    it('returns 403 if caller is not the host', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'guest-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', host_user_id: 'host-user', status: 'lobby' },
          error: null,
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await startGameHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(403);
    });

    it('rejects start game if already in progress (double-start)', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'host-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', host_user_id: 'host-user', status: 'in_progress' },
          error: null,
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await startGameHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('game_already_started');
    });

    it('rejects start game if player count < 5', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'host-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', host_user_id: 'host-user', status: 'lobby' },
          error: null,
        }),
      });

      // Exactly 4 players: one below the minimum, and every one ready, so the
      // player-count check is unambiguously the thing rejecting this.
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 'p1', seat_number: 1, is_alive: true, is_ready: true },
            { id: 'p2', seat_number: 2, is_alive: true, is_ready: true },
            { id: 'p3', seat_number: 3, is_alive: true, is_ready: true },
            { id: 'p4', seat_number: 4, is_alive: true, is_ready: true },
          ],
          error: null,
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await startGameHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('Need at least 5 players');
    });

    it('rejects start game if some players are not ready', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'host-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', host_user_id: 'host-user', status: 'lobby' },
          error: null,
        }),
      });

      // 5 players, but p3 not ready
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 'p1', seat_number: 1, is_alive: true, is_ready: true },
            { id: 'p2', seat_number: 2, is_alive: true, is_ready: true },
            { id: 'p3', seat_number: 3, is_alive: true, is_ready: false },
            { id: 'p4', seat_number: 4, is_alive: true, is_ready: true },
            { id: 'p5', seat_number: 5, is_alive: true, is_ready: true },
          ],
          error: null,
        }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await startGameHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('player(s) are not ready');
    });

    it('successfully starts game and invokes start_game RPC when all conditions are met', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'host-user' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'room-123', host_user_id: 'host-user', status: 'lobby' },
          error: null,
        }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 'p1', seat_number: 1, is_alive: true, is_ready: true },
            { id: 'p2', seat_number: 2, is_alive: true, is_ready: true },
            { id: 'p3', seat_number: 3, is_alive: true, is_ready: true },
            { id: 'p4', seat_number: 4, is_alive: true, is_ready: true },
            { id: 'p5', seat_number: 5, is_alive: true, is_ready: true },
          ],
          error: null,
        }),
      });

      mockAdminRpc.mockResolvedValueOnce({ error: null }); // set_role_config
      mockAdminRpc.mockResolvedValueOnce({
        data: { ok: true, roundNumber: 1, playerCount: 5 },
        error: null,
      }); // start_game

      const req = new Request('http://localhost:3000/api/rooms/room-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await startGameHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, roundNumber: 1, playerCount: 5 });
      expect(mockAdminRpc).toHaveBeenCalledWith('start_game', expect.objectContaining({
        p_room_id: 'room-123',
        p_user_id: 'host-user',
      }));
    });
  });

  describe('GET /api/rooms/[roomId]/my-role', () => {
    it('returns only the requesting player secret', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'player-user-1' } }, error: null });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'player-id-1', display_name: 'Alice', seat_number: 1, is_alive: true },
          error: null,
        }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { role_key: 'seer', alignment: 'village' },
          error: null,
        }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      });

      // Round lookup, then this player's own night action for that round.
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { round_number: 2 }, error: null }),
      });

      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      });

      const req = new Request('http://localhost:3000/api/rooms/room-123/my-role');
      const res = await getMyRoleHandler(req, { params: Promise.resolve({ roomId: 'room-123' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        playerId: 'player-id-1',
        displayName: 'Alice',
        seatNumber: 1,
        roleKey: 'seer',
        alignment: 'village',
        nightAction: null,
        investigations: [],
      });
    });
  });
});
