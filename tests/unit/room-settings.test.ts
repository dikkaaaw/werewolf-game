import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetUser = vi.fn();
const mockAdminFrom = vi.fn();
const mockAdminRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
    rpc: mockAdminRpc,
  })),
}));

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async (bucket: string, identifier: string) =>
    mockCheckRateLimit(bucket, identifier),
  ),
}));

import { POST as settingsHandler } from '@/app/api/rooms/[roomId]/settings/route';
import { POST as startHandler } from '@/app/api/rooms/[roomId]/start/route';
import {
  compositionFromCounts,
  defaultPhaseSeconds,
  isValidPhaseSeconds,
  phaseSecondsBoundsFor,
  phaseSecondsFromRoomSettings,
  roleCountsFromEntries,
  roleEntriesFromCounts,
  toPhaseDurationOverrides,
  validatePhaseSeconds,
} from '@/lib/game/room-settings';

/**
 * Route mocks are keyed by TABLE NAME rather than queued per call.
 *
 * An earlier `mockReturnValueOnce` chain broke the moment a route gained one
 * more query (or one fewer, on an early return): every subsequent result slid
 * onto the wrong query and a host check silently read a player row. Routing by
 * name makes the mock independent of call order, which is what a test of
 * authorization logic actually needs.
 */
type FromResult = { data: unknown; error: unknown };

function installFrom(handlers: Record<string, FromResult>): void {
  mockAdminFrom.mockImplementation((table: string) => {
    const result = handlers[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    const settle = async () => result;
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.single = vi.fn(settle);
    // Any terminal awaited directly (no `.single()`), e.g. `.order(...)`.
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      settle().then(resolve, reject);
    return chain;
  });
}

/** Five ready, alive players — the minimum startable roster. */
const FIVE_READY = Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`,
  user_id: `u${i}`,
  seat_number: i + 1,
  is_alive: true,
  is_ready: true,
}));

const ROOM_LOBBY: FromResult = {
  data: { id: 'room-1', host_user_id: 'host-1', status: 'lobby', max_players: 20, settings: {} },
  error: null,
};

// --- Pure module: phase durations -------------------------------------------

describe('validatePhaseSeconds', () => {
  it('falls back to the built-in defaults when nothing is supplied', () => {
    const result = validatePhaseSeconds(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phaseSeconds).toEqual(defaultPhaseSeconds());
  });

  it('accepts a full set inside the bounds', () => {
    const result = validatePhaseSeconds({ night: 45, day: 90, voting: 30 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phaseSeconds).toEqual({ night: 45, day: 90, voting: 30 });
    }
  });

  it('fills in phases the host did not mention', () => {
    const result = validatePhaseSeconds({ day: 120 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phaseSeconds.day).toBe(120);
      expect(result.phaseSeconds.night).toBe(defaultPhaseSeconds().night);
      expect(result.phaseSeconds.voting).toBe(defaultPhaseSeconds().voting);
    }
  });

  it('rejects a duration below the per-phase floor rather than clamping', () => {
    const result = validatePhaseSeconds({ night: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe('phaseSeconds.night');
    }
  });

  it('rejects a duration above the per-phase ceiling', () => {
    const result = validatePhaseSeconds({ day: 1200 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer duration', () => {
    expect(validatePhaseSeconds({ voting: 12.5 }).ok).toBe(false);
    expect(validatePhaseSeconds({ voting: '30' as unknown as number }).ok).toBe(false);
  });

  it('rejects an unknown phase key', () => {
    const result = validatePhaseSeconds({ dusk: 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toMatch(/Unknown phase/);
  });

  it('rejects a non-object payload', () => {
    expect(validatePhaseSeconds([1, 2, 3]).ok).toBe(false);
    expect(validatePhaseSeconds('nope').ok).toBe(false);
  });
});

describe('phase bounds', () => {
  it('keeps the built-in default inside its own bounds', () => {
    // The bounds used to start at 15 while the default was 10, so the default
    // was itself an invalid setting and a host who saved "the current values"
    // was rejected.
    const defaults = defaultPhaseSeconds();
    for (const phase of ['night', 'day', 'voting'] as const) {
      const { min, max } = phaseSecondsBoundsFor(phase);
      expect(defaults[phase]).toBeGreaterThanOrEqual(min);
      expect(defaults[phase]).toBeLessThanOrEqual(max);
      expect(isValidPhaseSeconds(phase, defaults[phase])).toBe(true);
    }
  });

  it('keeps night and voting tighter than day', () => {
    expect(phaseSecondsBoundsFor('night').max).toBeLessThan(phaseSecondsBoundsFor('day').max);
  });
});

describe('phaseSecondsFromRoomSettings', () => {
  it('returns the defaults for a missing or malformed settings row', () => {
    expect(phaseSecondsFromRoomSettings(null)).toEqual(defaultPhaseSeconds());
    expect(phaseSecondsFromRoomSettings({})).toEqual(defaultPhaseSeconds());
    expect(phaseSecondsFromRoomSettings({ phaseSeconds: 'oops' })).toEqual(defaultPhaseSeconds());
    expect(phaseSecondsFromRoomSettings({ phaseSeconds: [1, 2] })).toEqual(defaultPhaseSeconds());
  });

  it('clamps an out-of-range stored value rather than throwing', () => {
    const resolved = phaseSecondsFromRoomSettings({
      phaseSeconds: { night: 99999, day: 1, voting: 30 },
    });
    expect(resolved.night).toBe(phaseSecondsBoundsFor('night').max);
    expect(resolved.day).toBe(phaseSecondsBoundsFor('day').min);
    expect(resolved.voting).toBe(30);
  });

  it('ignores non-numeric entries', () => {
    const resolved = phaseSecondsFromRoomSettings({
      phaseSeconds: { night: 'soon', day: 60, voting: null },
    });
    expect(resolved.night).toBe(defaultPhaseSeconds().night);
    expect(resolved.day).toBe(60);
    expect(resolved.voting).toBe(defaultPhaseSeconds().voting);
  });

  it('produces overrides phase-manager can consume', () => {
    expect(toPhaseDurationOverrides({ night: 45, day: 90, voting: 30 })).toEqual({
      night: 45,
      day: 90,
      voting: 30,
    });
  });
});

// --- Pure module: role composition -------------------------------------------

describe('role composition helpers', () => {
  it('reduces entries to counts, summing duplicates and dropping zeros', () => {
    const counts = roleCountsFromEntries([
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'seer', roleCount: 0, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
    ]);
    expect(counts).toEqual({ werewolf: 2, villager: 3 });
  });

  it('round-trips the four editable counts into entries', () => {
    const entries = roleEntriesFromCounts({ werewolf: 1, seer: 1, guardian_angel: 1, villager: 2 });
    expect(entries.map((e) => e.roleKey)).toEqual(['werewolf', 'seer', 'guardian_angel', 'villager']);
    expect(roleCountsFromEntries(entries)).toEqual({
      werewolf: 1,
      seer: 1,
      guardian_angel: 1,
      villager: 2,
    });
  });

  it('adopts a saved composition that matches the roster', () => {
    const saved = compositionFromCounts(
      { werewolf: 2, seer: 1, guardian_angel: 1, villager: 6 },
      10,
      roleEntriesFromCounts({ werewolf: 1, seer: 1, guardian_angel: 1, villager: 7 }),
    );
    expect(saved).toEqual({ werewolf: 2, seer: 1, guardian_angel: 1, villager: 6 });
  });

  it('falls back to the default when the saved total no longer matches the roster', () => {
    // A player joined after the host saved 5 players' worth of roles.
    const fallback = roleEntriesFromCounts({ werewolf: 2, seer: 1, guardian_angel: 1, villager: 2 });
    const resolved = compositionFromCounts({ werewolf: 2, seer: 1, guardian_angel: 1, villager: 1 }, 6, fallback);
    expect(resolved).toEqual({ werewolf: 2, seer: 1, guardian_angel: 1, villager: 2 });
  });

  it('falls back to the default when nothing has been saved', () => {
    const fallback = roleEntriesFromCounts({ werewolf: 1, seer: 1, guardian_angel: 1, villager: 2 });
    expect(compositionFromCounts(undefined, 5, fallback)).toEqual({
      werewolf: 1,
      seer: 1,
      guardian_angel: 1,
      villager: 2,
    });
  });
});
// --- Route: POST /api/rooms/[roomId]/settings -------------------------------

function settingsRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/rooms/room-1/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function startRequest(body: unknown = {}): Request {
  return new Request('http://localhost:3000/api/rooms/room-1/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ roomId: 'room-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'host-1' } }, error: null });
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: new Date(Date.now() + 60000).toISOString(),
  });
});

describe('POST /api/rooms/[roomId]/settings', () => {
  it('returns 401 when the caller is unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    installFrom({});

    const res = await settingsHandler(settingsRequest({ phaseSeconds: { night: 45 } }), params);
    expect(res.status).toBe(401);
  });

  it('rejects a non-host with 403 and never reaches the RPC', async () => {
    installFrom({
      rooms: {
        data: { id: 'room-1', host_user_id: 'someone-else', status: 'lobby', settings: {} },
        error: null,
      },
    });

    const res = await settingsHandler(settingsRequest({ phaseSeconds: { night: 45 } }), params);

    expect(res.status).toBe(403);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('refuses a settings change once the game has started', async () => {
    installFrom({
      rooms: {
        data: { id: 'room-1', host_user_id: 'host-1', status: 'in_progress', settings: {} },
        error: null,
      },
    });

    const res = await settingsHandler(settingsRequest({ phaseSeconds: { night: 45 } }), params);

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('game_already_started');
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('rejects an out-of-bounds duration before writing anything', async () => {
    installFrom({ rooms: ROOM_LOBBY });

    const res = await settingsHandler(settingsRequest({ phaseSeconds: { night: 5 } }), params);

    expect(res.status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('rejects role counts that do not match the roster', async () => {
    installFrom({
      rooms: ROOM_LOBBY,
      room_players: { data: [{ id: 'p1' }], error: null },
    });

    const res = await settingsHandler(
      settingsRequest({
        roles: [
          { roleKey: 'werewolf', roleCount: 1, config: {} },
          { roleKey: 'villager', roleCount: 4, config: {} },
        ],
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('rejects a composition with zero Werewolves', async () => {
    installFrom({
      rooms: ROOM_LOBBY,
      room_players: { data: FIVE_READY, error: null },
    });

    const res = await settingsHandler(
      settingsRequest({
        roles: [
          { roleKey: 'seer', roleCount: 1, config: {} },
          { roleKey: 'guardian_angel', roleCount: 1, config: {} },
          { roleKey: 'villager', roleCount: 3, config: {} },
        ],
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('saves valid settings and reports the authoritative stored state', async () => {
    // The route reads the room once for the guard, then re-reads it (plus
    // room_role_configs) to echo back what the DATABASE holds. Routing by
    // table name cannot distinguish those two `rooms` reads, so this one test
    // installs its own stateful handler instead.
    let roomReads = 0;
    mockAdminFrom.mockImplementation((table: string) => {
      const result: FromResult =
        table === 'rooms'
          ? roomReads++ === 0
            ? ROOM_LOBBY
            : { data: { settings: { phaseSeconds: { night: 45 } }, state_version: 3 }, error: null }
          : table === 'room_players'
            ? { data: FIVE_READY, error: null }
            : table === 'room_role_configs'
              ? { data: [{ role_key: 'werewolf', role_count: 1 }], error: null }
              : { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const settle = async () => result;
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.single = vi.fn(settle);
      chain.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
        settle().then(r, j);
      return chain;
    });
    mockAdminRpc.mockResolvedValue({ data: { ok: true }, error: null });

    const res = await settingsHandler(
      settingsRequest({
        phaseSeconds: { night: 45 },
        roles: [
          { roleKey: 'werewolf', roleCount: 1, config: {} },
          { roleKey: 'seer', roleCount: 1, config: {} },
          { roleKey: 'guardian_angel', roleCount: 1, config: {} },
          { roleKey: 'villager', roleCount: 2, config: {} },
        ],
      }),
      params,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // Echoes what the DATABASE holds, never what was submitted.
    expect(json.settings.phaseSeconds.night).toBe(45);
    expect(json.roleCounts).toEqual({ werewolf: 1 });
    expect(mockAdminRpc).toHaveBeenCalledWith(
      'set_room_settings',
      expect.objectContaining({ p_user_id: 'host-1', p_room_id: 'room-1' }),
    );
  });

  it('reports a rate-limited caller without touching the database', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
    installFrom({});

    const res = await settingsHandler(settingsRequest({ phaseSeconds: { night: 45 } }), params);

    expect(res.status).toBe(429);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });
});

// --- Start Game honours the saved configuration ------------------------------

describe('POST /api/rooms/[roomId]/start uses the saved configuration', () => {
  /** Wire the mocks for a startable lobby. `savedRoles` is what the host saved. */
  function installStartable(
    savedRoles: Array<{ role_key: string; role_count: number }> | null,
    roomSettings: Record<string, unknown> = {},
  ) {
    installFrom({
      rooms: {
        data: { id: 'room-1', host_user_id: 'host-1', status: 'lobby', max_players: 20, settings: roomSettings },
        error: null,
      },
      room_players: { data: FIVE_READY, error: null },
      room_role_configs: savedRoles ? { data: savedRoles, error: null } : { data: [], error: null },
    });
    mockAdminRpc.mockImplementation(async (fn: string) =>
      fn === 'set_role_config'
        ? { data: { ok: true }, error: null }
        : { data: { ok: true, roundNumber: 1 }, error: null },
    );
  }

  function rpcCall(fn: string): Record<string, unknown> | undefined {
    const call = mockAdminRpc.mock.calls.find((c) => c[0] === fn);
    return call?.[1] as Record<string, unknown> | undefined;
  }

  const BALANCED_SAVED = [
    { role_key: 'werewolf', role_count: 1 },
    { role_key: 'seer', role_count: 1 },
    { role_key: 'guardian_angel', role_count: 1 },
    { role_key: 'villager', role_count: 2 },
  ];

  it('uses the host-saved night duration instead of a hardcoded default', async () => {
    installStartable(BALANCED_SAVED, { phaseSeconds: { night: 45, day: 90, voting: 30 } });

    const res = await startHandler(startRequest(), params);

    expect(res.status).toBe(200);
    expect(rpcCall('start_game')?.p_night_seconds).toBe(45);
  });

  it('falls back to the built-in default when no duration was saved', async () => {
    installStartable(BALANCED_SAVED);

    const res = await startHandler(startRequest(), params);

    expect(res.status).toBe(200);
    expect(rpcCall('start_game')?.p_night_seconds).toBe(defaultPhaseSeconds().night);
  });

  it('loads the composition the host saved rather than the balanced default', async () => {
    // 2 Werewolves among 5 — the 5-player default would have dealt only 1.
    installStartable([
      { role_key: 'werewolf', role_count: 2 },
      { role_key: 'seer', role_count: 1 },
      { role_key: 'guardian_angel', role_count: 1 },
      { role_key: 'villager', role_count: 1 },
    ]);

    const res = await startHandler(startRequest(), params);
    expect(res.status).toBe(200);

    const entries = rpcCall('set_role_config')?.p_entries as Array<{
      roleKey: string;
      roleCount: number;
    }>;
    expect(entries.map((e) => `${e.roleKey}:${e.roleCount}`).sort()).toEqual([
      'guardian_angel:1',
      'seer:1',
      'villager:1',
      'werewolf:2',
    ]);
  });

  it('falls back to the balanced default when nothing was ever saved', async () => {
    installStartable(null);

    const res = await startHandler(startRequest(), params);
    expect(res.status).toBe(200);

    const entries = rpcCall('set_role_config')?.p_entries as Array<{
      roleKey: string;
      roleCount: number;
    }>;
    // 5-player default: 1 Werewolf + 1 Seer + 1 Doctor + 2 Villagers.
    expect(entries.map((e) => `${e.roleKey}:${e.roleCount}`).sort()).toEqual([
      'guardian_angel:1',
      'seer:1',
      'villager:2',
      'werewolf:1',
    ]);
  });

  it('prevents starting when the saved composition no longer matches the roster', async () => {
    // Three roles saved for a five-player room: a join happened and the host
    // never rebalanced. Start must refuse rather than deal a broken game.
    installStartable([
      { role_key: 'werewolf', role_count: 1 },
      { role_key: 'seer', role_count: 1 },
      { role_key: 'villager', role_count: 1 },
    ]);

    const res = await startHandler(startRequest(), params);

    expect(res.status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('still enforces the five-player minimum', async () => {
    installFrom({
      rooms: ROOM_LOBBY,
      room_players: { data: FIVE_READY.slice(0, 4), error: null },
    });

    const res = await startHandler(startRequest(), params);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/at least 5 players/);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });
});
