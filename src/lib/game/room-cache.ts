/**
 * Client-side cache for room snapshots and the caller's private role.
 *
 * Why this exists: the room page used to re-request `/api/rooms/:id` from a
 * 1s countdown tick, a 4s heartbeat, and every Realtime event, and each of
 * those room reads also re-requested `/api/rooms/:id/my-role`. A single
 * deadline crossing could therefore fire a dozen identical requests.
 *
 * Design constraints this module deliberately respects:
 *
 *  - **Server stays authoritative.** Nothing here reimplements gameplay: the
 *    snapshot's `revealedRole`, `votes` and derived counts are computed on the
 *    server and are cached verbatim. Events invalidate, they never mutate.
 *  - **Private data is user-scoped.** Role entries are keyed by
 *    `${userId}:${roomId}`, so one account can never observe another's role.
 *    `clearPrivateCaches()` drops them on logout / account change.
 *  - **Errors are never cached.** A failed request propagates to the caller so
 *    genuine API errors stay visible instead of being masked by a stale hit.
 *  - **Only client-side.** Authenticated, membership-scoped responses are held
 *    in module memory in the browser tab; nothing here touches a shared or
 *    server-side cache.
 */

import type { SafeRoom } from './safe-room';

/** How long a room snapshot may be reused without revalidation. */
export const ROOM_TTL_MS = 2_000;

/**
 * How long a private role may be reused. Investigations are appended when a
 * night resolves, which also advances the phase, so the page invalidates the
 * role explicitly on a phase/round change rather than relying on this TTL.
 */
export const ROLE_TTL_MS = 30_000;

/**
 * The shape returned by `GET /api/rooms/:roomId/my-role`. The investigation
 * payload mirrors the server's `result_payload` for a Seer reading.
 */
export interface MyRoleSnapshot {
  playerId: string;
  displayName: string;
  seatNumber: number;
  roleKey: string;
  alignment: string;
  /**
   * The caller's own night action for the current round, or null if they have
   * not acted yet. Lets the UI stop offering an action the server would reject
   * rather than letting the button reload and do nothing.
   */
  nightAction: {
    actionType: string;
    targetPlayerId: string | null;
  } | null;
  investigations: Array<{
    roundNumber: number;
    result: { targetPlayerId: string; alignment: string };
  }>;
  hunterAction?: { deadlineAt: string; targets: Array<{ id: string; displayName: string }> } | null;
}

export type RoomResult =
  | { ok: true; room: SafeRoom; fromCache: boolean }
  | { ok: false; status: number; message: string };

export type RoleResult =
  | { ok: true; role: MyRoleSnapshot; fromCache: boolean }
  | { ok: false; status: number; message: string };

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

const roomCache = new Map<string, CacheEntry<SafeRoom>>();
const roleCache = new Map<string, CacheEntry<MyRoleSnapshot>>();

/** In-flight promises, so N concurrent callers share one network request. */
const roomInFlight = new Map<string, Promise<RoomResult>>();
const roleInFlight = new Map<string, Promise<RoleResult>>();

/**
 * Race guards.
 *
 * Three ways a late response could otherwise corrupt the cache:
 *
 *  1. **Force joining a stale in-flight request.** A post-mutation refresh
 *     (`force: true`) must not be satisfied by a request issued BEFORE the
 *     mutation, so a forced call issues its own request instead of joining.
 *  2. **Out-of-order responses.** If two requests are genuinely in flight, the
 *     one that resolves last must not overwrite newer data, so each response
 *     carries a sequence number and only writes if it is the newest issued.
 *  3. **Write-after-invalidate / write-after-logout.** A response that arrives
 *     after `invalidateRoom` or `clearAllCaches` must be discarded rather than
 *     repopulating the cache that was just cleared. Generations detect this.
 */
let epoch = 0;
const roomInvalidation = new Map<string, number>();
/**
 * Role generations are scoped by ROOM, not by user key. A per-key map could
 * only bump keys that already had an entry, so a first-ever role request for a
 * room would sail past an invalidation issued while it was in flight.
 */
const roleRoomInvalidation = new Map<string, number>();
const roomSeq = new Map<string, number>();
const roleSeq = new Map<string, number>();
const roomWritten = new Map<string, number>();
const roleWritten = new Map<string, number>();

const nextSeq = (map: Map<string, number>, key: string): number => {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
};

/** True when `captured` is still the newest generation for this key. */
const isCurrentRoomGeneration = (roomId: string, capturedEpoch: number, capturedGen: number) =>
  epoch === capturedEpoch && (roomInvalidation.get(roomId) ?? 0) === capturedGen;

const isCurrentRoleGeneration = (
  roomId: string,
  capturedEpoch: number,
  capturedGen: number,
) => epoch === capturedEpoch && (roleRoomInvalidation.get(roomId) ?? 0) === capturedGen;

const roleKey = (userId: string, roomId: string) => `${userId}:${roomId}`;

function fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): T | undefined {
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > ttl) return undefined;
  return entry.value;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Fetch the room snapshot, reusing a fresh cache entry and collapsing
 * concurrent callers onto a single request.
 */
export function fetchRoomSnapshot(
  roomId: string,
  options: { force?: boolean } = {},
): Promise<RoomResult> {
  if (!options.force) {
    const hit = fresh(roomCache.get(roomId), ROOM_TTL_MS);
    if (hit) return Promise.resolve({ ok: true, room: hit, fromCache: true });
  }

  // A forced call must NOT join an existing request: that request may have been
  // issued before the mutation the caller is trying to refresh past.
  const existing = options.force ? undefined : roomInFlight.get(roomId);
  if (existing) return existing;

  const capturedEpoch = epoch;
  const capturedGen = roomInvalidation.get(roomId) ?? 0;
  const seq = nextSeq(roomSeq, roomId);

  // Holder so the `finally` block can compare identity without referencing
  // `request` inside its own initialiser (a temporal-dead-zone error).
  const slot: { promise?: Promise<RoomResult> } = {};

  const request = (async (): Promise<RoomResult> => {
    try {
      const res = await fetch(`/api/rooms/${roomId}`);
      if (!res.ok) {
        const body = await readJson(res);
        const message =
          (body.error as { message?: string } | undefined)?.message ??
          'Failed to load room details.';
        return { ok: false, status: res.status, message };
      }
      const data = await res.json();
      const room = data?.room as SafeRoom | undefined;
      if (!room) return { ok: false, status: res.status, message: 'No room data received.' };

      // Only the newest response of a still-current generation may populate the
      // cache. A late response for a superseded request, or one that lands after
      // an invalidate/logout, is returned to its own caller but never stored.
      const newestWritten = roomWritten.get(roomId) ?? 0;
      if (
        isCurrentRoomGeneration(roomId, capturedEpoch, capturedGen) &&
        seq >= newestWritten
      ) {
        roomCache.set(roomId, { value: room, storedAt: Date.now() });
        roomWritten.set(roomId, seq);
      }
      return { ok: true, room, fromCache: false };
    } finally {
      // Only release the slot if it is still ours: a forced request may have
      // superseded us, and deleting its entry would orphan the dedup map.
      if (slot.promise && roomInFlight.get(roomId) === slot.promise) {
        roomInFlight.delete(roomId);
      }
    }
  })();

  slot.promise = request;

  if (!options.force) roomInFlight.set(roomId, request);
  return request;
}

/**
 * Fetch the caller's private role. Entries are keyed per user AND room, so the
 * cache can never serve one player's role to another.
 */
export function fetchMyRoleSnapshot(
  roomId: string,
  userId: string,
  options: { force?: boolean } = {},
): Promise<RoleResult> {
  if (!userId) {
    return Promise.resolve({ ok: false, status: 401, message: 'Authentication required.' });
  }
  const key = roleKey(userId, roomId);

  if (!options.force) {
    const hit = fresh(roleCache.get(key), ROLE_TTL_MS);
    if (hit) return Promise.resolve({ ok: true, role: hit, fromCache: true });
  }

  const existing = options.force ? undefined : roleInFlight.get(key);
  if (existing) return existing;

  const capturedEpoch = epoch;
  const capturedGen = roleRoomInvalidation.get(roomId) ?? 0;
  const seq = nextSeq(roleSeq, key);

  const slot: { promise?: Promise<RoleResult> } = {};

  const request = (async (): Promise<RoleResult> => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/my-role`);
      if (!res.ok) {
        const body = await readJson(res);
        const message =
          (body.error as { message?: string } | undefined)?.message ?? 'Failed to retrieve your role.';
        return { ok: false, status: res.status, message };
      }
      const data = await res.json();
      const role = data as MyRoleSnapshot;

      // Same guards as the room snapshot: a superseded or post-logout response
      // must not repopulate the private-role cache.
      const newestWritten = roleWritten.get(key) ?? 0;
      if (
        isCurrentRoleGeneration(roomId, capturedEpoch, capturedGen) &&
        seq >= newestWritten
      ) {
        roleCache.set(key, { value: role, storedAt: Date.now() });
        roleWritten.set(key, seq);
      }
      return { ok: true, role, fromCache: false };
    } finally {
      if (slot.promise && roleInFlight.get(key) === slot.promise) {
        roleInFlight.delete(key);
      }
    }
  })();

  slot.promise = request;

  if (!options.force) roleInFlight.set(key, request);
  return request;
}

/** Drop the cached snapshot for a room (and, by default, its private role). */
export function invalidateRoom(roomId: string, options: { keepRole?: boolean } = {}): void {
  roomCache.delete(roomId);
  // Bump the generation so any request already in flight for this room can no
  // longer write its (now stale) result back into the cache.
  roomInvalidation.set(roomId, (roomInvalidation.get(roomId) ?? 0) + 1);
  if (!options.keepRole) {
    for (const key of [...roleCache.keys()]) {
      if (key.endsWith(`:${roomId}`)) roleCache.delete(key);
    }
    // Covers every user of this room, including one with no cached entry yet.
    roleRoomInvalidation.set(roomId, (roleRoomInvalidation.get(roomId) ?? 0) + 1);
  }
}

/**
 * Drop the private role for a room across every user. Called when the phase or
 * round moves, because a resolved night appends new investigations.
 */
export function invalidateRolesForRoom(roomId: string): void {
  for (const key of [...roleCache.keys()]) {
    if (key.endsWith(`:${roomId}`)) roleCache.delete(key);
  }
  roleRoomInvalidation.set(roomId, (roleRoomInvalidation.get(roomId) ?? 0) + 1);
}

/**
 * Drop all private role entries. Used on logout / account change so a signed-out
 * tab cannot surface the previous account's role from memory.
 */
export function clearPrivateCaches(): void {
  roleCache.clear();
  // A global epoch bump invalidates every in-flight response, so a request that
  // was issued for the previous session cannot land afterwards.
  epoch += 1;
}

/** Drop everything. Used on logout and by tests. */
export function clearAllCaches(): void {
  roomCache.clear();
  roleCache.clear();
  roomInFlight.clear();
  roleInFlight.clear();
  // Invalidate in-flight responses that would otherwise repopulate the cache
  // that was just cleared.
  epoch += 1;
}

/** Test/diagnostic helper: how many entries are currently cached. */
export function cacheSizes(): { rooms: number; roles: number } {
  return { rooms: roomCache.size, roles: roleCache.size };
}