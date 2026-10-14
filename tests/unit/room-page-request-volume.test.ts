import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllCaches,
  fetchMyRoleSnapshot,
  fetchRoomSnapshot,
  invalidateRolesForRoom,
  ROOM_TTL_MS,
} from '@/lib/game/room-cache';

/**
 * These exercise the request-amplification path the room page used to have:
 * a room snapshot read unconditionally triggered a private-role read, so a
 * countdown tick, a heartbeat and a Realtime event each produced TWO requests.
 * The role is now read from cache and only re-fetched when the authoritative
 * phase/round actually moves.
 */

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SNAPSHOT = {
  id: 'room-1',
  roomCode: 'ABC234',
  status: 'in_progress',
  phase: 'night',
  roundNumber: 1,
  maxPlayers: 8,
  currentPlayers: 5,
  hostUserId: 'host-1',
  expiresAt: null,
  stateVersion: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  players: [],
};

const ROLE = {
  playerId: 'p1',
  displayName: 'Alice',
  seatNumber: 2,
  roleKey: 'seer',
  alignment: 'village',
  investigations: [],
};

/**
 * Mirrors the page's decision: a snapshot read populates the room cache, and
 * the role is only forced when the phase/round moved since the last snapshot.
 */
async function pageFetchRoom(previous: typeof SNAPSHOT | null) {
  const result = await fetchRoomSnapshot('room-1', previous ? { force: true } : undefined);
  if (!result.ok) return { room: previous, phaseMoved: false };

  const phaseMoved =
    !previous ||
    previous.status !== result.room.status ||
    previous.phase !== result.room.phase ||
    previous.roundNumber !== result.room.roundNumber;

  if (result.room.status === 'in_progress' || result.room.status === 'finished') {
    if (phaseMoved && previous) {
      invalidateRolesForRoom('room-1');
      await fetchMyRoleSnapshot('room-1', 'user-a', { force: true });
    } else {
      await fetchMyRoleSnapshot('room-1', 'user-a');
    }
  }
  return { room: result.room, phaseMoved };
}

describe('room page request amplification', () => {
  let roomCalls = 0;
  let roleCalls = 0;
  // The snapshot the fake server serves; individual tests retarget it.
  let served: Record<string, unknown> = SNAPSHOT;

  beforeEach(() => {
    clearAllCaches();
    vi.useFakeTimers();
    roomCalls = 0;
    roleCalls = 0;
    served = SNAPSHOT;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/my-role')) {
          roleCalls += 1;
          return jsonResponse(ROLE);
        }
        roomCalls += 1;
        return jsonResponse({ room: served });
      }),
    );
  });

  afterEach(() => {
    clearAllCaches();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('first load fetches the room once and the role once', async () => {
    await pageFetchRoom(null);
    expect(roomCalls).toBe(1);
    expect(roleCalls).toBe(1);
  });

  it('does not refetch the room when it is served from cache', async () => {
    await fetchRoomSnapshot('room-1');
    await fetchRoomSnapshot('room-1');
    await fetchRoomSnapshot('room-1');
    expect(roomCalls).toBe(1);
  });

  it('does not refetch the private role while the phase is unchanged', async () => {
    await pageFetchRoom(null);
    // Heartbeat / Realtime ticks inside the same TTL and phase.
    await pageFetchRoom(SNAPSHOT);
    await pageFetchRoom(SNAPSHOT);
    await pageFetchRoom(SNAPSHOT);

    expect(roleCalls).toBe(1);
  });

  it('re-reads the role exactly once when the phase advances', async () => {
    await pageFetchRoom(null);
    expect(roleCalls).toBe(1);

    const next = { ...SNAPSHOT, phase: 'day', roundNumber: 1, stateVersion: 5 };
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    await pageFetchRoom(next);

    expect(roleCalls).toBe(2);
  });

  it('re-reads the role when the round advances, so new investigations appear', async () => {
    await pageFetchRoom(null);
    const nextRound = { ...SNAPSHOT, phase: 'night', roundNumber: 2, stateVersion: 9 };
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    await pageFetchRoom(nextRound);

    expect(roleCalls).toBe(2);
  });

  it('collapses a burst of snapshot reads into a single room request', async () => {
    // Simulates several Realtime events landing in the same tick.
    await Promise.all([
      fetchRoomSnapshot('room-1'),
      fetchRoomSnapshot('room-1'),
      fetchRoomSnapshot('room-1'),
      fetchRoomSnapshot('room-1'),
    ]);
    expect(roomCalls).toBe(1);
  });

  it('does not request the role at all while the room is still in the lobby', async () => {
    const lobby = { ...SNAPSHOT, status: 'lobby', phase: 'lobby', roundNumber: 0 };
    served = lobby;
    await pageFetchRoom(null);
    expect(roleCalls).toBe(0);

    await pageFetchRoom(lobby);
    expect(roleCalls).toBe(0);
    expect(roomCalls).toBe(2);
  });
});