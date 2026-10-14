import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Builds an admin client stub whose `from()` calls resolve the room, roster,
 * secrets and actions reads the night branch performs, and whose `rpc()` is
 * driven per test so the commit outcome can be controlled precisely.
 */
function makeAdmin(opts: {
  commitResult: { data?: unknown; error?: unknown };
}) {
  const { commitResult } = opts;

  const query = (data: unknown) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.single = vi.fn(async () => ({ data, error: null }));
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(res);
    return b;
  };

  const rows: Record<string, unknown[]> = {
    room_players: [
      { id: 'w1', seat_number: 1, display_name: 'Wolf', is_alive: true },
      { id: 'v1', seat_number: 2, display_name: 'Villager', is_alive: true },
      { id: 'd1', seat_number: 3, display_name: 'Doc', is_alive: true },
      { id: 's1', seat_number: 4, display_name: 'Seer', is_alive: true },
      { id: 'v2', seat_number: 5, display_name: 'Villager2', is_alive: true },
    ],
    player_secrets: [
      { player_id: 'w1', role_key: 'werewolf', alignment: 'werewolf' },
      { player_id: 'v1', role_key: 'villager', alignment: 'village' },
      { player_id: 'd1', role_key: 'doctor', alignment: 'village' },
      { player_id: 's1', role_key: 'seer', alignment: 'village' },
      { player_id: 'v2', role_key: 'villager', alignment: 'village' },
    ],
    game_actions: [
      {
        id: 'act-1',
        actor_player_id: 'w1',
        action_type: 'eliminate',
        target_player_id: 'v1',
      },
    ],
    game_action_results: [],
  };

  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    // `args` is accepted so the recorded call shape matches production
    // (rpc(name, params)); only `name` drives the stubbed behaviour.
    void args;
    if (name === 'claim_phase_transition') {
      return { data: { ok: true, claim: 'claim-token' }, error: null };
    }
    return commitResult;
  });

  const from = vi.fn((table: string) => query(rows[table] ?? []));

  return { from, rpc };
}

const ROOM = {
  id: 'room-1',
  status: 'in_progress',
  phase: 'night',
  round_number: 1,
  state_version: 1,
  // Already past its deadline, so the function proceeds to claim+resolve.
  phase_ends_at: new Date(Date.now() - 60_000).toISOString(),
};

describe('advanceRoomPhaseIfExpired — night -> day commit outcome', () => {
  beforeEach(() => vi.clearAllMocks());

  async function run(admin: ReturnType<typeof makeAdmin>) {
    vi.doMock('@/lib/supabase/server', () => ({
      createServerClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
      createAdminClient: vi.fn(() => admin),
    }));
    vi.resetModules();
    const { advanceRoomPhaseIfExpired } = await import('@/lib/server/phase-advancement');
    return advanceRoomPhaseIfExpired('room-1');
  }

  it('returns true and commits to day when the claim is honoured', async () => {
    const admin = makeAdmin({ commitResult: { data: { ok: true }, error: null } });
    // The room read must resolve the in-progress, expired room.
    const originalFrom = admin.from.getMockImplementation()!;
    admin.from.mockImplementation((table: string) =>
      table === 'rooms'
        ? (() => {
            const b: Record<string, unknown> = {};
            b.select = vi.fn(() => b);
            b.eq = vi.fn(() => b);
            b.single = vi.fn(async () => ({ data: ROOM, error: null }));
            return b;
          })()
        : originalFrom(table),
    );

    const advanced = await run(admin);
    expect(advanced).toBe(true);
    const commitCall = admin.rpc.mock.calls.find(
      (c) => c[0] === 'commit_phase_transition',
    );
    expect(commitCall).toBeDefined();
    expect(commitCall![1]).toMatchObject({ p_next_phase: 'day' });
  });

  it('returns FALSE when the claim is lost (night was never committed)', async () => {
    // This is the regression: a lost claim comes back as a normal result with
    // ok:false, not as an RPC error. It used to be ignored, so the caller was
    // told the phase advanced while the room was still sitting in `night`.
    const admin = makeAdmin({
      commitResult: {
        data: { ok: false, error: { code: 'claim_lost', message: 'The transition claim was lost or already committed.' } },
        error: null,
      },
    });
    const originalFrom = admin.from.getMockImplementation()!;
    admin.from.mockImplementation((table: string) =>
      table === 'rooms'
        ? (() => {
            const b: Record<string, unknown> = {};
            b.select = vi.fn(() => b);
            b.eq = vi.fn(() => b);
            b.single = vi.fn(async () => ({ data: ROOM, error: null }));
            return b;
          })()
        : originalFrom(table),
    );

    const advanced = await run(admin);
    expect(advanced).toBe(false);
  });

  it('returns false when the commit RPC itself errors', async () => {
    const admin = makeAdmin({
      commitResult: { data: null, error: { message: 'connection reset' } },
    });
    const originalFrom = admin.from.getMockImplementation()!;
    admin.from.mockImplementation((table: string) =>
      table === 'rooms'
        ? (() => {
            const b: Record<string, unknown> = {};
            b.select = vi.fn(() => b);
            b.eq = vi.fn(() => b);
            b.single = vi.fn(async () => ({ data: ROOM, error: null }));
            return b;
          })()
        : originalFrom(table),
    );

    const advanced = await run(admin);
    // The error is surfaced through the catch, which returns false.
    expect(advanced).toBe(false);
  });

  it('does not advance when the room is not in progress', async () => {
    const admin = makeAdmin({ commitResult: { data: { ok: true }, error: null } });
    const originalFrom = admin.from.getMockImplementation()!;
    admin.from.mockImplementation((table: string) =>
      table === 'rooms'
        ? (() => {
            const b: Record<string, unknown> = {};
            b.select = vi.fn(() => b);
            b.eq = vi.fn(() => b);
            b.single = vi.fn(async () => ({
              data: { ...ROOM, status: 'lobby', phase: 'lobby', phase_ends_at: null },
              error: null,
            }));
            return b;
          })()
        : originalFrom(table),
    );

    const advanced = await run(admin);
    expect(advanced).toBe(false);
    expect(admin.rpc).not.toHaveBeenCalledWith(
      'commit_phase_transition',
      expect.anything(),
    );
  });
});