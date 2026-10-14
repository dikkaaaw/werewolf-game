import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cacheSizes,
  clearAllCaches,
  fetchMyRoleSnapshot,
  fetchRoomSnapshot,
  invalidateRoom,
  invalidateRolesForRoom,
} from '@/lib/game/room-cache';
import type { SafeRoom } from '@/lib/game/safe-room';

/**
 * Regression tests for the three ways a late HTTP response used to corrupt the
 * cache. These are the failure modes that only appear under real network
 * timing, which is exactly why they need pinning before deployment.
 */

function room(id = 'room-1', phase = 'night'): SafeRoom {
  return {
    id,
    roomCode: 'ABC234',
    status: 'in_progress',
    phase,
    roundNumber: 1,
    maxPlayers: 8,
    currentPlayers: 5,
    hostUserId: 'host-1',
    expiresAt: null,
    stateVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    players: [],
  } as SafeRoom;
}

function role(key: string) {
  return {
    playerId: 'p1',
    displayName: key,
    seatNumber: 1,
    roleKey: 'seer',
    alignment: 'village',
    investigations: [],
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** A fetch stub whose responses are resolved manually, one per queued call. */
function controllableFetch() {
  const pending: Array<(r: Response) => void> = [];
  const mock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      }),
  );
  vi.stubGlobal('fetch', mock);
  return {
    mock,
    pending,
    resolveAt(index: number, body: unknown) {
      pending[index](jsonResponse(body));
    },
  };
}

describe('room-cache race conditions', () => {
  beforeEach(() => {
    clearAllCaches();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllCaches();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a forced refresh is NOT satisfied by a request issued before the mutation', async () => {
    const f = controllableFetch();

    // A background/heartbeat read goes out first.
    const stale = fetchRoomSnapshot('room-1');
    // The player then mutates and forces a refresh while the first is still open.
    const forced = fetchRoomSnapshot('room-1', { force: true });

    expect(f.mock).toHaveBeenCalledTimes(2);

    f.resolveAt(1, { room: room('room-1', 'day') }); // the forced (newer) read
    f.resolveAt(0, { room: room('room-1', 'night') }); // the stale read lands last

    await expect(forced).resolves.toMatchObject({ ok: true });
    await expect(stale).resolves.toMatchObject({ ok: true });

    // The cache must hold the NEWER phase, not the older response that arrived last.
    const cached = await fetchRoomSnapshot('room-1');
    expect(cached.ok && cached.room.phase).toBe('day');
  });

  it('a slow older response cannot overwrite a newer one', async () => {
    const f = controllableFetch();

    const first = fetchRoomSnapshot('room-1', { force: true });
    const second = fetchRoomSnapshot('room-1', { force: true });

    f.resolveAt(1, { room: room('room-1', 'day') });
    f.resolveAt(0, { room: room('room-1', 'night') });

    await first;
    await second;

    const cached = await fetchRoomSnapshot('room-1');
    expect(cached.ok && cached.room.phase).toBe('day');
  });

  it('does not repopulate the room cache after invalidateRoom', async () => {
    const f = controllableFetch();

    const pending = fetchRoomSnapshot('room-1');
    // The user navigates away before the response lands.
    invalidateRoom('room-1');
    f.resolveAt(0, { room: room() });
    await pending;

    expect(cacheSizes().rooms).toBe(0);
  });

  it('does not repopulate caches after clearAllCaches (logout / account change)', async () => {
    const f = controllableFetch();

    const pendingRoom = fetchRoomSnapshot('room-1');
    const pendingRole = fetchMyRoleSnapshot('room-1', 'user-a');
    expect(f.mock).toHaveBeenCalledTimes(2);

    // The user signs out while both requests are in flight.
    clearAllCaches();
    f.resolveAt(0, { room: room() });
    f.resolveAt(1, role('Alice'));
    await pendingRoom;
    await pendingRole;

    expect(cacheSizes()).toEqual({ rooms: 0, roles: 0 });
  });

  it('a role response that lands after logout is never stored for that user', async () => {
    const f = controllableFetch();

    const pending = fetchMyRoleSnapshot('room-1', 'user-a');
    clearAllCaches(); // logout
    f.resolveAt(0, role('Alice'));
    await pending;

    // The signed-out tab holds nothing.
    expect(cacheSizes().roles).toBe(0);
  });

  it('a stale role response cannot overwrite a newer one', async () => {
    const f = controllableFetch();

    const older = fetchMyRoleSnapshot('room-1', 'user-a', { force: true });
    const newer = fetchMyRoleSnapshot('room-1', 'user-a', { force: true });

    f.resolveAt(1, { ...role('Alice'), roleKey: 'doctor' });
    f.resolveAt(0, { ...role('Alice'), roleKey: 'werewolf' });

    await older;
    await newer;

    const cached = await fetchMyRoleSnapshot('room-1', 'user-a');
    expect(cached.ok && cached.role.roleKey).toBe('doctor');
  });

  it('does not store a role response that lands after a phase invalidation', async () => {
    const f = controllableFetch();

    const pending = fetchMyRoleSnapshot('room-1', 'user-a');
    // A resolved night appends investigations, so the page invalidates the role.
    invalidateRolesForRoom('room-1');
    f.resolveAt(0, role('Alice'));
    await pending;

    expect(cacheSizes().roles).toBe(0);
  });

  it('still returns the response to the caller even when it is not cached', async () => {
    const f = controllableFetch();

    const pending = fetchRoomSnapshot('room-1');
    invalidateRoom('room-1');
    f.resolveAt(0, { room: room('room-1', 'day') });

    // Discarded from the cache, but the caller that asked still gets its data.
    await expect(pending).resolves.toMatchObject({
      ok: true,
      room: { phase: 'day' },
    });
    expect(cacheSizes().rooms).toBe(0);
  });
});