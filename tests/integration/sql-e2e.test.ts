import { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Runs the REAL `advanceRoomPhaseIfExpired` against the REAL Postgres RPCs.
 *
 * PostgREST is not required: the admin client below is a thin adapter that
 * speaks the small query subset `phase-advancement.ts` uses, and translates
 * `rpc(name, args)` into a direct `select * from public.name($1, ...)`. The
 * RPCs are `security definer`, so claim/commit/finish semantics exercised here
 * are the production ones rather than a mock's idea of them.
 */

const PGURL = process.env.LOCAL_PG_URL;
const suite = PGURL ? describe : describe.skip;

let pool: Pool;
let admin: ReturnType<typeof makeAdmin>;

if (!PGURL) {
  console.warn(
    '[sql-e2e] skipping: set LOCAL_PG_URL to run phase advancement against real RPCs.',
  );
}

vi.mock('server-only', () => ({}));

const g = globalThis as unknown as { __sqlAdmin?: unknown };

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: () => g.__sqlAdmin,
}));

type Row = Record<string, unknown>;

function makeAdmin(p: Pool) {
  const build = (table: string) => {
    let cols = '*';
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown]> = [];
    let mode: 'many' | 'single' | 'maybe' | 'insert' = 'many';

    const b: Record<string, unknown> = {};
    b.select = (c: string) => {
      cols = c;
      return b;
    };
    b.eq = (c: string, v: unknown) => {
      eqs.push([c, v]);
      return b;
    };
    b.in = (c: string, v: unknown) => {
      ins.push([c, v]);
      return b;
    };
    b.order = () => b;

    const buildWhere = () => {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [c, v] of eqs) {
        params.push(v);
        where.push(`${c} = $${params.length}`);
      }
      for (const [c, v] of ins) {
        const arr = Array.isArray(v) ? v : [v];
        if (arr.length === 0) return { sql: ' where false', params };
        const ph = arr.map((x) => {
          params.push(x);
          return `$${params.length}`;
        });
        where.push(`${c} in (${ph.join(',')})`);
      }
      return { sql: where.length ? ` where ${where.join(' and ')}` : '', params };
    };

    const runSelect = async () => {
      const { sql, params } = buildWhere();
      let rows: Row[];
      try {
        const r = await p.query(`select ${cols} from public.${table}${sql}`, params as never[]);
        rows = r.rows;
      } catch (e) {
        throw e;
      }
      if (mode === 'single' || mode === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    b.single = () => {
      mode = 'single';
      return runSelect();
    };
    b.maybeSingle = () => {
      mode = 'maybe';
      return runSelect();
    };
    b.then = (res: (v: unknown) => unknown) => runSelect().then(res);
    return b;
  };

  const rpc = async (name: string, args: Row = {}) => {
    const keys = Object.keys(args);
    // jsonb params must be serialised; pg would otherwise send [object Object].
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const ph = keys.map((_, i) => `$${i + 1}`);
    try {
      const { rows } = await p.query(
        `select * from public.${name}(${ph.join(',')})`,
        params as never[],
      );
      // `select * from public.fn(...)` wraps a jsonb return in a column named
      // after the function; PostgREST hands back the bare jsonb. Unwrap to match.
      const wrapped = rows[0] as Record<string, unknown> | undefined;
      const data = wrapped && name in wrapped ? wrapped[name] : wrapped ?? null;
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };

  return { from: build, rpc };
}

async function loadAdvance() {
  vi.resetModules();
  const mod = await import('@/lib/server/phase-advancement');
  return mod.advanceRoomPhaseIfExpired;
}

async function seedRoom(opts: {
  phase: string;
  round: number;
  alignments: Array<'werewolf' | 'village'>;
}) {
  const user = await pool.query(
    `insert into auth.users (email) values ($1) returning id`,
    [`host-${Date.now()}-${Math.random()}@test.local`],
  );
  const hostId = user.rows[0].id as string;

  const { rows } = await pool.query(
    `insert into public.rooms
       (room_code, host_user_id, max_players, status, phase, round_number, phase_ends_at, state_version, settings)
     values (upper(substr(md5(random()::text),1,6)), $1, 12,
             'in_progress', $2, $3, now() - interval '1 minute', 7, '{}'::jsonb)
     returning id`,
    [hostId, opts.phase, opts.round],
  );
  const roomId = rows[0].id as string;

  const ids: string[] = [];
  for (let i = 0; i < opts.alignments.length; i += 1) {
    const align = opts.alignments[i];
    const u = await pool.query(
      `insert into auth.users (email) values ($1) returning id`,
      [`p${i}-${Date.now()}-${Math.random()}@test.local`],
    );
    const p = await pool.query(
      `insert into public.room_players (room_id, user_id, display_name, seat_number)
       values ($1, $2, $3, $4) returning id`,
      [roomId, u.rows[0].id, `P${i + 1}`, i + 1],
    );
    const pid = p.rows[0].id as string;
    await pool.query(
      `insert into public.player_secrets (player_id, role_key, alignment) values ($1,$2,$3)`,
      [pid, align === 'werewolf' ? 'werewolf' : 'villager', align],
    );
    ids.push(pid);
  }
  return { roomId, ids };
}

const roomRow = (roomId: string) =>
  pool
    .query(
      `select status, phase, round_number, state_version, transition_claim,
              settings->>'winner' as winner, phase_ends_at
         from public.rooms where id = $1`,
      [roomId],
    )
    .then((r) => r.rows[0] as Row);

const aliveRows = (roomId: string) =>
  pool
    .query(
      `select rp.id, rp.is_alive, rp.death_cause
         from public.room_players rp where rp.room_id = $1 order by rp.seat_number`,
      [roomId],
    )
    .then((r) => r.rows as Array<Row>);

suite('phase advancement vs real RPCs', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: PGURL });
    admin = makeAdmin(pool);
    g.__sqlAdmin = admin;
  });

  it('1. vote eliminates the last Werewolf -> Village wins, room finished', async () => {
    const { roomId, ids } = await seedRoom({
      phase: 'voting',
      round: 3,
      alignments: ['werewolf', 'village', 'village', 'village'],
    });
    const [wolf, ...villagers] = ids;
    for (const v of villagers) {
      await pool.query(
        `insert into public.game_votes (room_id, round_number, voter_player_id, target_player_id)
         values ($1,3,$2,$3)`,
        [roomId, v, wolf],
      );
    }

    const advance = await loadAdvance();
    const advanced = await advance(roomId);

    const room = await roomRow(roomId);
    const players = await aliveRows(roomId);

    expect(room.status).toBe('finished');
    expect(room.winner).toBe('village');
    expect(advanced).toBe(true);
    expect(players.filter((p) => p.is_alive === false)).toHaveLength(1);
    // The Wolf is the one voted out; a missing or misplaced elimination is the
    // P0 defect that `finish_game` was changed to fix.
    expect(players.find((p) => p.id === wolf)?.is_alive).toBe(false);

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);

  it('2. night kill reaches parity -> Werewolves win, room finished', async () => {
    const { roomId, ids } = await seedRoom({
      phase: 'night',
      round: 2,
      alignments: ['werewolf', 'werewolf', 'village', 'village', 'village'],
    });
    const [w1, , v3] = ids;
    await pool.query(
      `insert into public.game_actions (room_id, round_number, actor_player_id, action_type, target_player_id)
       values ($1,2,$2,'eliminate',$3)`,
      [roomId, w1, v3],
    );

    const advance = await loadAdvance();
    const advanced = await advance(roomId);

    const room = await roomRow(roomId);
    expect(advanced).toBe(true);
    expect(room.status).toBe('finished');
    expect(room.winner).toBe('werewolf');

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);

  it('3. FINAL WEREWOLF dies at night resolution -> Village wins', async () => {
    // Reachable only if a wolf can die at night; assert the actual behaviour
    // rather than assuming it cannot happen.
    const { roomId, ids } = await seedRoom({
      phase: 'night',
      round: 2,
      alignments: ['werewolf', 'village', 'village', 'village', 'village'],
    });
    await pool.query(
      `insert into public.game_actions (room_id, round_number, actor_player_id, action_type, target_player_id)
       values ($1,2,$2,'eliminate',$3)`,
      [roomId, ids[1], ids[0]],
    );

    const advance = await loadAdvance();
    await advance(roomId);

    const room = await roomRow(roomId);
    const players = await aliveRows(roomId);

    expect(room.status).toBe('finished');
    expect(room.winner).toBe('village');
    expect(players.find((p) => p.id === ids[0])?.is_alive).toBe(false);
    expect(players.filter((p) => p.is_alive === false)).toHaveLength(1);

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);

  it('4. a second call after finishing must not change anything (idempotent)', async () => {
    const { roomId, ids } = await seedRoom({
      phase: 'voting',
      round: 3,
      alignments: ['werewolf', 'village', 'village', 'village'],
    });
    const [wolf, ...villagers] = ids;
    for (const v of villagers) {
      await pool.query(
        `insert into public.game_votes (room_id, round_number, voter_player_id, target_player_id)
         values ($1,3,$2,$3)`,
        [roomId, v, wolf],
      );
    }

    const advance = await loadAdvance();
    await advance(roomId);
    const first = await roomRow(roomId);
    expect(first.status).toBe('finished');
    expect(first.winner).toBe('village');

    const evts = await pool.query(
      `select count(*)::int as n from public.game_events where room_id=$1 and event_type='game_finished'`,
      [roomId],
    );
    // The first finish logs its terminal event exactly once -- no dups from the
    // transient phase write, no missing terminal notification for the UI.
    expect(evts.rows[0].n).toBe(1);

    // Drain any leftovers the first finish left behind, then retry.
    await pool.query(`delete from public.game_events where room_id=$1`, [roomId]);
    const second = await advance(roomId);
    const after = await roomRow(roomId);
    // A finished room has nothing left to settle: no second transition, and
    // above all no second `game_finished` event to replay downstream.
    expect(second).toBe(false);
    expect(after.status).toBe('finished');
    expect(after.winner).toBe('village');

    const evtsAfterRetry = await pool.query(
      `select count(*)::int as n from public.game_events where room_id=$1 and event_type='game_finished'`,
      [roomId],
    );
    expect(evtsAfterRetry.rows[0].n).toBe(0);

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);

  it('5. a finished room accepts no further actions', async () => {
    const { roomId, ids } = await seedRoom({
      phase: 'voting',
      round: 3,
      alignments: ['werewolf', 'village', 'village', 'village'],
    });
    const [wolf, ...villagers] = ids;
    for (const v of villagers) {
      await pool.query(
        `insert into public.game_votes (room_id, round_number, voter_player_id, target_player_id)
         values ($1,3,$2,$3)`,
        [roomId, v, wolf],
      );
    }
    const advance = await loadAdvance();
    await advance(roomId);

    const res = await admin.rpc('cast_vote', {
      p_room_id: roomId,
      p_user_id: '00000000-0000-4000-8000-0000000000ff',
      p_target_player_id: wolf,
    });
    expect((res.data as Row | null)?.ok).toBe(false);

    const again = await advance(roomId);
    expect(again).toBe(false);
    const room = await roomRow(roomId);
    expect(room.status).toBe('finished');

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);
});
suite('claim durability', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: PGURL });
    admin = makeAdmin(pool);
    g.__sqlAdmin = admin;
  });

  it('a failed resolution releases the claim so the next request can retry', async () => {
    const { roomId, ids } = await seedRoom({
      phase: 'voting',
      round: 3,
      alignments: ['werewolf', 'village', 'village', 'village'],
    });
    const [wolf, ...villagers] = ids;
    for (const v of villagers) {
      await pool.query(
        `insert into public.game_votes (room_id, round_number, voter_player_id, target_player_id)
         values ($1,3,$2,$3)`,
        [roomId, v, wolf],
      );
    }

    // Fail exactly where production can fail: after a successful claim, the
    // terminal RPC is rejected by the database.
    const broken = {
      ...admin,
      rpc: async (name: string, args: Row = {}) => {
        if (name === 'finish_game' || name === 'tick_room') {
          return { data: null, error: { message: 'simulated transient DB failure' } };
        }
        return admin.rpc(name, args);
      },
    };
    g.__sqlAdmin = broken;

    const advance = await loadAdvance();
    const advanced = await advance(roomId);
    // A failure must never be reported as a successful advancement.
    expect(advanced).toBe(false);
    const stuck = (await roomRow(roomId)) as Row;

    // A correct client retries immediately (deadline already passed).
    g.__sqlAdmin = admin;
    const retry = await advance(roomId);
    const after = (await roomRow(roomId)) as Row;

    // The whole point of the fix: the failed attempt hands the claim back, so
    // the room is claimable again immediately and the retry finishes the game.
    expect(stuck.transition_claim).toBeNull();
    expect(retry).toBe(true);
    expect(after.status).toBe('finished');
    expect(after.winner).toBe('village');

    await pool.query(`delete from public.rooms where id=$1`, [roomId]);
  }, 30_000);
});

suite('full-game simulation vs real RPCs', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: PGURL });
    admin = makeAdmin(pool);
    g.__sqlAdmin = admin;
  });

  it('plays whole games to a terminal state without stalling', async () => {
    const advance = await loadAdvance();
    const outcomes: string[] = [];

    for (let game = 0; game < 8; game += 1) {
      const nWolves = game % 2 === 0 ? 2 : 1;
      const alignments: Array<'werewolf' | 'village'> = [
        ...Array.from({ length: nWolves }, () => 'werewolf' as const),
        ...Array.from({ length: 8 - nWolves }, () => 'village' as const),
      ];
      const { roomId } = await seedRoom({ phase: 'night', round: 1, alignments });

      let guard = 0;
      let status = 'in_progress';
      let winner: string | null = null;

      while (status === 'in_progress' && guard < 40) {
        guard += 1;
        const row = (await roomRow(roomId)) as Row;

        // Everyone still alive, wolves first.
        const alive = (
          await pool.query(
            `select rp.id, rp.seat_number from public.room_players rp
              where rp.room_id=$1 and rp.is_alive order by rp.seat_number`,
            [roomId],
          )
        ).rows as Array<Row>;
        const wolfIds = (
          await pool.query(
            `select rp.id from public.room_players rp
               join public.player_secrets s on s.player_id = rp.id
              where rp.room_id=$1 and rp.is_alive and s.alignment='werewolf'`,
            [roomId],
          )
        ).rows.map((r: Row) => r.id as string);

        if (row.phase === 'night' && wolfIds.length > 0) {
          const prey = alive.find((a) => !wolfIds.includes(a.id as string))!;
          for (const w of wolfIds) {
            await pool.query(
              `insert into public.game_actions
                 (room_id, round_number, actor_player_id, action_type, target_player_id)
               values ($1,$2,$3,'eliminate',$4)
               on conflict (room_id, round_number, actor_player_id, action_type)
               do update set target_player_id = excluded.target_player_id`,
              [roomId, row.round_number, w, prey.id],
            );
          }
        }
        if (row.phase === 'voting') {
          // Everyone votes for the first living wolf they can see.
          const prey = wolfIds[0] ?? alive[0]?.id;
          if (prey) {
            for (const v of alive) {
              if (v.id === prey) continue;
              await pool.query(
                `insert into public.game_votes
                   (room_id, round_number, voter_player_id, target_player_id)
                 values ($1,$2,$3,$4)
                 on conflict (room_id, round_number, voter_player_id)
                 do update set target_player_id = excluded.target_player_id`,
                [roomId, row.round_number, v.id, prey],
              );
            }
          }
        }

        // Expire the current phase, then let the production path resolve it.
        await pool.query(
          `update public.rooms set phase_ends_at = now() - interval '1 second' where id=$1`,
          [roomId],
        );
        await advance(roomId);
        const after = (await roomRow(roomId)) as Row;
        status = after.status as string;
        winner = (after.winner as string) ?? null;
      }

      outcomes.push(`game${game}: status=${status} winner=${winner} steps=${guard}`);
      await pool.query(`delete from public.rooms where id=$1`, [roomId]);
    }

    expect(outcomes.every((o) => o.includes('status=finished'))).toBe(true);
  }, 120_000);
});
