import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
const mockCheckRateLimit = vi.fn();

// The membership gate reads `rooms` through the session client before any
// privileged work, so the stub must model that read for authenticated callers.
const chainRow = (r: unknown): unknown => ({
  select: vi.fn(() => chainRow(r)),
  eq: vi.fn(() => chainRow(r)),
  single: vi.fn(async () => ({ data: r, error: null })),
  then: (res: (v: unknown) => unknown) => Promise.resolve({ data: r, error: null }).then(res),
});

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: () => chainRow({ id: 'room-1' }),
  })),
  createAdminClient: vi.fn(() => ({
    rpc: (name: string, ...args: unknown[]) => {
      if (name === 'tick_room') {
        return Promise.resolve({ data: { ok: true, advanced: false }, error: null });
      }
      return mockAdminRpc(name, ...args);
    },
  })),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn((bucket: string, identifier: string) =>
    mockCheckRateLimit(bucket, identifier),
  ),
}));

import { POST as submitActionHandler } from '@/app/api/rooms/[roomId]/actions/route';
import { POST as castVoteHandler } from '@/app/api/rooms/[roomId]/votes/route';

describe('Gameplay Actions API Routes (PRD Compliance)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  describe('POST /api/rooms/[roomId]/actions (Night Actions)', () => {
    it('rejects unauthenticated caller with 401', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'eliminate',
          targetPlayerId: '11111111-1111-4111-8111-111111111111',
        }),
      });

      const res = await submitActionHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects action if not night phase with 409 conflict', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-user' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { code: 'not_night_phase', message: 'The night phase is over.' },
        },
        error: null,
      });

      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'eliminate',
          targetPlayerId: '11111111-1111-4111-8111-111111111111',
        }),
      });

      const res = await submitActionHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('not_night_phase');
    });

    it('submits valid night action via RPC with verified session user.id', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-wolf-user' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: { ok: true, roundNumber: 1 },
        error: null,
      });

      const targetId = '22222222-2222-4222-8222-222222222222';
      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'eliminate',
          targetPlayerId: targetId,
        }),
      });

      const res = await submitActionHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        ok: true,
        actionType: 'eliminate',
        targetPlayerId: targetId,
        roundNumber: 1,
      });

      expect(mockAdminRpc).toHaveBeenCalledWith('submit_night_action', {
        p_room_id: 'room-1',
        p_user_id: 'verified-wolf-user',
        p_action_type: 'eliminate',
        p_target_player_id: targetId,
      });
    });

    it('rejects invalid targets when RPC returns target_is_self error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'doctor-user' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { code: 'target_is_self', message: 'You cannot target yourself.' },
        },
        error: null,
      });

      const selfId = '44444444-4444-4111-8444-444444444444';
      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'protect',
          targetPlayerId: selfId,
        }),
      });

      const res = await submitActionHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.error.code).toBe('target_is_self');
      expect(json.error.message).toBe('You cannot target yourself.');
    });

    it('surfaces the Doctor repeat-target rule as a clear 400 to the client', async () => {
      // Task 5, option (b): the server keeps enforcing the consecutive-night
      // Doctor rule and the UI already displays whatever error the route
      // returns via `setError(data.error?.message)`. This pins the contract that
      // the client receives a stable code and an actionable message — so a
      // Doctor who re-selects last night's target is told why, not left guessing.
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-doctor-user' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: {
            code: 'repeat_target_forbidden',
            message: 'You cannot protect the same player two nights running.',
          },
        },
        error: null,
      });

      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'protect',
          targetPlayerId: '55555555-5555-4111-8555-555555555555',
        }),
      });

      const res = await submitActionHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.error.code).toBe('repeat_target_forbidden');
      expect(json.error.message).toBe('You cannot protect the same player two nights running.');
    });

    it('surfaces the same-role targeting rules as clear 400s to the client', async () => {
      // A1/A2 reach the client the same way: a stable code plus a message that
      // names the rule, so the UI can act on it without string-sniffing.
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-wolf-user' } },
        error: null,
      });

      const req = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'eliminate',
          targetPlayerId: '66666666-6666-4111-8666-666666666666',
        }),
      });

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { code: 'target_is_werewolf', message: 'Werewolves cannot target another Werewolf.' },
        },
        error: null,
      });
      const wolfRes = await submitActionHandler(req, { params: Promise.resolve({ roomId: 'room-1' }) });
      expect(wolfRes.status).toBe(400);
      expect((await wolfRes.json()).error.code).toBe('target_is_werewolf');

      mockAdminRpc.mockResolvedValue({
        data: {
          ok: false,
          error: { code: 'target_is_doctor', message: 'A Doctor cannot protect another Doctor.' },
        },
        error: null,
      });
      const doctorRes = await submitActionHandler(
        new Request('http://localhost:3000/api/rooms/room-1/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actionType: 'protect',
            targetPlayerId: '66666666-6666-4111-8666-666666666666',
          }),
        }),
        { params: Promise.resolve({ roomId: 'room-1' }) },
      );
      expect(doctorRes.status).toBe(400);
      expect((await doctorRes.json()).error.code).toBe('target_is_doctor');
    });

    it('allows retargeting / repeated action submissions before deadline', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-wolf-user' } },
        error: null,
      });

      // First submission target A
      mockAdminRpc.mockResolvedValueOnce({
        data: { ok: true, roundNumber: 1 },
        error: null,
      });

      const targetA = '22222222-2222-4222-8222-222222222222';
      const req1 = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'eliminate', targetPlayerId: targetA }),
      });
      const res1 = await submitActionHandler(req1, { params: Promise.resolve({ roomId: 'room-1' }) });
      expect(res1.status).toBe(200);

      // Second submission target B (retargeting)
      mockAdminRpc.mockResolvedValueOnce({
        data: { ok: true, roundNumber: 1 },
        error: null,
      });

      const targetB = '33333333-3333-4333-8333-333333333333';
      const req2 = new Request('http://localhost:3000/api/rooms/room-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'eliminate', targetPlayerId: targetB }),
      });
      const res2 = await submitActionHandler(req2, { params: Promise.resolve({ roomId: 'room-1' }) });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.targetPlayerId).toBe(targetB);
    });
  });

  describe('POST /api/rooms/[roomId]/votes (Open Voting)', () => {
    it('submits vote during voting phase with verified session user.id', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'verified-voter' } },
        error: null,
      });

      mockAdminRpc.mockResolvedValue({
        data: { ok: true, roundNumber: 1 },
        error: null,
      });

      const targetId = '33333333-3333-4333-8333-333333333333';
      const req = new Request('http://localhost:3000/api/rooms/room-1/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetPlayerId: targetId,
        }),
      });

      const res = await castVoteHandler(req, {
        params: Promise.resolve({ roomId: 'room-1' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        ok: true,
        targetPlayerId: targetId,
        roundNumber: 1,
      });

      expect(mockAdminRpc).toHaveBeenCalledWith('cast_vote', {
        p_room_id: 'room-1',
        p_user_id: 'verified-voter',
        p_target_player_id: targetId,
      });
    });
  });
});
