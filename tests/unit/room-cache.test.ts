import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ROLE_TTL_MS,
  ROOM_TTL_MS,
  cacheSizes,
  clearAllCaches,
  clearPrivateCaches,
  fetchMyRoleSnapshot,
  fetchRoomSnapshot,
  invalidateRoom,
  invalidateRolesForRoom,
} from '@/lib/game/room-cache';
import type { SafeRoom } from '@/lib/game/safe-room';

function room(overrides: Partial<SafeRoom> = {}): SafeRoom {
  return {
    id: 'room-1',
    roomCode: 'ABC234',
    status: 'lobby',
    phase: 'lobby',
    roundNumber: 0,
    maxPlayers: 8,
    currentPlayers: 1,
    hostUserId: 'host-1',
    expiresAt: null,
    stateVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    players: [],
    ...overrides,
  } as SafeRoom;
}

function role(overrides: Record<string, unknown> = {}) {
  return {
    playerId: 'player-1',
    displayName: 'Alice',
    seatNumber: 2,
    roleKey: 'seer',
    alignment: 'village',
    investigations: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('room-cache', () => {
  beforeEach(() => {
    clearAllCaches();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllCaches();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('room snapshot caching', () => {
    it('serves a second call from cache without a second request', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      const first = await fetchRoomSnapshot('room-1');
      const second = await fetchRoomSnapshot('room-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.ok && first.fromCache).toBe(false);
      expect(second.ok && second.fromCache).toBe(true);
      expect(second.ok && second.room.id).toBe('room-1');
    });

    it('deduplicates concurrent requests for the same room into one call', async () => {
      let resolveFetch: (r: Response) => void = () => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const inFlight = [
        fetchRoomSnapshot('room-1'),
        fetchRoomSnapshot('room-1'),
        fetchRoomSnapshot('room-1'),
      ];
      resolveFetch(jsonResponse({ room: room() }));
      const results = await Promise.all(inFlight);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('keeps caches separate per room id', async () => {
      const fetchMock = vi.fn(async (url: string) =>
        jsonResponse({ room: room({ id: url.includes('room-2') ? 'room-2' : 'room-1' }) }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchRoomSnapshot('room-2');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cacheSizes().rooms).toBe(2);
    });

    it('refetches once the TTL expires', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      vi.advanceTimersByTime(ROOM_TTL_MS + 1);
      await fetchRoomSnapshot('room-1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache when forced', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      const forced = await fetchRoomSnapshot('room-1', { force: true });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(forced.ok && forced.fromCache).toBe(false);
    });

    it('releases the in-flight slot so a retry can succeed after a failure', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 500))
        .mockResolvedValueOnce(jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      const failed = await fetchRoomSnapshot('room-1');
      expect(failed.ok).toBe(false);

      // A later attempt must not be poisoned by the failed in-flight entry.
      const retried = await fetchRoomSnapshot('room-1', { force: true });
      expect(retried.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never caches an error, so genuine API failures stay visible', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { message: 'Failed to load room details.' } }, 500),
      );
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchRoomSnapshot('room-1', { force: true });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cacheSizes().rooms).toBe(0);
    });

    it('surfaces the server error message rather than masking it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: { message: 'Room not found.' } }, 404)),
      );

      const result = await fetchRoomSnapshot('room-1');
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: 'Room not found.',
      });
    });
  });

  describe('private role caching', () => {
    it('caches the role per user so a second render makes no request', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      await fetchMyRoleSnapshot('room-1', 'user-a');
      const second = await fetchMyRoleSnapshot('room-1', 'user-a');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second.ok && second.role.roleKey).toBe('seer');
    });

    it('never serves one user the role cached for another user', async () => {
      // Identity comes from the session, not the URL, so the endpoint path is
      // identical for both callers. Return a different role per call to model
      // two distinct sessions.
      let call = 0;
      const fetchMock = vi.fn(async () => {
        call += 1;
        return jsonResponse(role({ roleKey: call === 1 ? 'seer' : 'werewolf' }));
      });
      vi.stubGlobal('fetch', fetchMock);

      const alice = await fetchMyRoleSnapshot('room-1', 'user-a');
      const bob = await fetchMyRoleSnapshot('room-1', 'user-b');

      // Two requests: the second user must not read the first user's entry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(alice.ok && alice.role.roleKey).toBe('seer');
      expect(bob.ok && bob.role.roleKey).toBe('werewolf');

      // Re-reading each user's own entry still hits their own cache.
      const aliceAgain = await fetchMyRoleSnapshot('room-1', 'user-a');
      expect(aliceAgain.ok && aliceAgain.role.roleKey).toBe('seer');
      expect(aliceAgain.ok && aliceAgain.fromCache).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps role caches separate per room for the same user', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      await fetchMyRoleSnapshot('room-1', 'user-a');
      await fetchMyRoleSnapshot('room-2', 'user-a');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cacheSizes().roles).toBe(2);
    });

    it('refuses to fetch a role without a user id', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchMyRoleSnapshot('room-1', '');

      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent role requests', async () => {
      let resolveFetch: (r: Response) => void = () => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const inFlight = [
        fetchMyRoleSnapshot('room-1', 'user-a'),
        fetchMyRoleSnapshot('room-1', 'user-a'),
      ];
      resolveFetch(jsonResponse(role()));
      await Promise.all(inFlight);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('drops every role entry for a room when the phase moves', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      await fetchMyRoleSnapshot('room-1', 'user-a');
      await fetchMyRoleSnapshot('room-2', 'user-a');
      expect(cacheSizes().roles).toBe(2);

      invalidateRolesForRoom('room-1');
      expect(cacheSizes().roles).toBe(1);

      // The surviving room-2 entry is still a cache hit...
      await fetchMyRoleSnapshot('room-2', 'user-a');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // ...while room-1 must be fetched again.
      await fetchMyRoleSnapshot('room-1', 'user-a');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('clears private role data on logout while keeping room snapshots', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchMyRoleSnapshot('room-1', 'user-a');
      expect(cacheSizes()).toEqual({ rooms: 1, roles: 1 });

      clearPrivateCaches();
      expect(cacheSizes()).toEqual({ rooms: 1, roles: 0 });
    });

    it('clears everything on an account change', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchMyRoleSnapshot('room-1', 'user-a');

      clearAllCaches();
      expect(cacheSizes()).toEqual({ rooms: 0, roles: 0 });
    });

    it('invalidates the room and its role together by default', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchMyRoleSnapshot('room-1', 'user-a');

      invalidateRoom('room-1');
      expect(cacheSizes()).toEqual({ rooms: 0, roles: 0 });
    });

    it('can invalidate the room while deliberately keeping the role', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ room: room() }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchRoomSnapshot('room-1');
      await fetchMyRoleSnapshot('room-1', 'user-a');

      invalidateRoom('room-1', { keepRole: true });
      expect(cacheSizes()).toEqual({ rooms: 0, roles: 1 });
    });
  });

  describe('expiry', () => {
    it('reuses a role inside its TTL', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      await fetchMyRoleSnapshot('room-1', 'user-a');
      vi.advanceTimersByTime(ROLE_TTL_MS - 1);
      await fetchMyRoleSnapshot('room-1', 'user-a');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refetches a role after its TTL', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(role()));
      vi.stubGlobal('fetch', fetchMock);

      await fetchMyRoleSnapshot('room-1', 'user-a');
      vi.advanceTimersByTime(ROLE_TTL_MS + 1);
      await fetchMyRoleSnapshot('room-1', 'user-a');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});