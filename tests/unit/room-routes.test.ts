import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
  createAdminClient: vi.fn(() => ({
    rpc: mockAdminRpc,
  })),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn((bucket: string, identifier: string) =>
    mockCheckRateLimit(bucket, identifier),
  ),
}));

import { POST as createRoomHandler } from '@/app/api/rooms/route';
import { POST as joinRoomHandler } from '@/app/api/rooms/join/route';

describe('Room Routes — Server Gatekeeper Pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 5,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  describe('POST /api/rooms (create room)', () => {
    it('returns 401 when unauthenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const request = new Request('http://localhost:3000/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice', maxPlayers: 10 }),
      });

      const res = await createRoomHandler(request);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });

    it('returns 400 when body fails schema validation', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
        error: null,
      });

      const request = new Request('http://localhost:3000/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'A', maxPlayers: 10 }), // Name too short (<2 chars)
      });

      const res = await createRoomHandler(request);
      expect(res.status).toBe(400);
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });

    it('passes session user.id to admin RPC and returns 200 on success', async () => {
      const verifiedUserId = 'user-uuid-1234';
      mockGetUser.mockResolvedValue({
        data: { user: { id: verifiedUserId } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: true,
          roomId: 'room-uuid-5678',
          roomCode: 'ABC234',
          playerId: 'player-uuid-9999',
        },
        error: null,
      });

      const request = new Request('http://localhost:3000/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Detective',
          maxPlayers: 10,
          userId: 'spoofed-attacker-id', // Schema strips this
        }),
      });

      const res = await createRoomHandler(request);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        roomId: 'room-uuid-5678',
        roomCode: 'ABC234',
        playerId: 'player-uuid-9999',
      });

      // Verify RPC was invoked with verified session user ID, NOT attacker-supplied ID
      expect(mockAdminRpc).toHaveBeenCalledWith('create_room', {
        p_user_id: verifiedUserId,
        p_display_name: 'Detective',
        p_max_players: 10,
      });
    });

    it('handles RPC application-level errors (ok: false)', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-uuid-1234' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { message: 'Could not allocate room code.' },
        },
        error: null,
      });

      const request = new Request('http://localhost:3000/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Detective', maxPlayers: 10 }),
      });

      const res = await createRoomHandler(request);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toBe('Could not allocate room code.');
    });

    it('returns 429 when rate limited', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-uuid-1234' } },
        error: null,
      });

      mockCheckRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 30000).toISOString(),
      });

      const request = new Request('http://localhost:3000/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Detective', maxPlayers: 10 }),
      });

      const res = await createRoomHandler(request);
      expect(res.status).toBe(429);
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/rooms/join (join room)', () => {
    it('returns 401 when unauthenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const request = new Request('http://localhost:3000/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: 'ABC234', displayName: 'Bob' }),
      });

      const res = await joinRoomHandler(request);
      expect(res.status).toBe(401);
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });

    it('passes session user.id to join_room admin RPC', async () => {
      const verifiedUserId = 'joiner-user-id';
      mockGetUser.mockResolvedValue({
        data: { user: { id: verifiedUserId } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: true,
          roomId: 'room-uuid-5678',
          roomCode: 'ABC234',
          playerId: 'player-uuid-7777',
          seatNumber: 2,
          playerCount: 2,
        },
        error: null,
      });

      const request = new Request('http://localhost:3000/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: 'abc234', displayName: 'Bob' }),
      });

      const res = await joinRoomHandler(request);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        playerId: 'player-uuid-7777',
        roomId: 'room-uuid-5678',
        roomCode: 'ABC234',
      });

      expect(mockAdminRpc).toHaveBeenCalledWith('join_room', {
        p_room_code: 'ABC234',
        p_user_id: verifiedUserId,
        p_display_name: 'Bob',
      });
    });

    it('returns 400 when join_room returns application error (e.g. room full)', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-id' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { message: 'That room is full.' },
        },
        error: null,
      });

      const request = new Request('http://localhost:3000/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: 'ABC234', displayName: 'Bob' }),
      });

      const res = await joinRoomHandler(request);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toBe('That room is full.');
    });
  });
});
