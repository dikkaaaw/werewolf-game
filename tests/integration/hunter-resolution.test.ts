import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PGURL = process.env.LOCAL_PG_URL;
const suite = PGURL ? describe : describe.skip;

if (!PGURL) {
  console.warn('[hunter-resolution] skipping: set LOCAL_PG_URL for real RPC tests.');
}

suite('Hunter durable prompt resolution against real RPCs', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: PGURL });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedRoom(hunterRole: 'hunter' | 'villager', targetRole: string) {
    const users: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await pool.query(
        `insert into auth.users (email) values ($1) returning id`,
        [`hunter-${randomUUID()}@test.local`],
      );
      users.push(result.rows[0].id as string);
    }

    const roomResult = await pool.query(
      `insert into rooms
        (room_code, host_user_id, status, phase, round_number, phase_ends_at)
       values ($1, $2, 'in_progress', 'night', 1, now() - interval '1 second')
       returning id`,
      [randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase(), users[0]],
    );
    const roomId = roomResult.rows[0].id as string;

    const players: Array<{ id: string; userId: string; role: string }> = [];
    for (let i = 0; i < users.length; i += 1) {
      const role = i === 0 ? hunterRole : i === 1 ? targetRole : 'villager';
      const alignment = role === 'hunter' || role === 'werewolf' ? 'werewolf' : 'village';
      const player = await pool.query(
        `insert into room_players (room_id, user_id, display_name, seat_number)
         values ($1, $2, $3, $4) returning id`,
        [roomId, users[i], `Player ${i + 1}`, i + 1],
      );
      const playerId = player.rows[0].id as string;
      await pool.query(
        `insert into player_secrets (player_id, role_key, alignment)
         values ($1, $2, $3)`,
        [playerId, role, alignment],
      );
      players.push({ id: playerId, userId: users[i], role });
    }

    return { roomId, players };
  }

  async function killHunter(roomId: string, hunterPlayerId: string) {
    await pool.query(`update rooms set transition_claim = $2 where id = $1`, [
      roomId,
      randomUUID(),
    ]);
    const claim = await pool.query(`select transition_claim from rooms where id = $1`, [roomId]);
    const result = await pool.query(
      `select * from public.commit_phase_transition($1, $2, 'day', 1, 60, $3::jsonb, $4::jsonb)`,
      [
        roomId,
        claim.rows[0].transition_claim,
        JSON.stringify([
          { playerId: hunterPlayerId, cause: 'night_elimination', seatNumber: 1, displayName: 'Player 1' },
        ]),
        JSON.stringify([{ eventType: 'day_started', payload: { roundNumber: 1 } }]),
      ],
    );
    return result.rows[0].commit_phase_transition as { ok: boolean };
  }

  it('raises a prompt with the death and applies exactly one shot', async () => {
    const { roomId, players } = await seedRoom('hunter', 'villager');
    const committed = await killHunter(roomId, players[0].id);
    expect(committed.ok).toBe(true);

    const prompted = await pool.query(
      `select prompt, prompt_deadline_at from room_players where id = $1`,
      [players[0].id],
    );
    expect(prompted.rows[0].prompt).toMatchObject({ type: 'hunter_final_shot' });
    expect(prompted.rows[0].prompt_deadline_at).not.toBeNull();
    expect(
      (await pool.query(`select public.room_has_unresolved_prompt($1) as blocked`, [roomId]))
        .rows[0].blocked,
    ).toBe(true);

    const shot = await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[0].userId, players[1].id],
    );
    expect((shot.rows[0] as { apply_hunter_final_shot: { ok: boolean } }).apply_hunter_final_shot.ok).toBe(true);
    expect((await pool.query(`select is_alive, death_cause from room_players where id = $1`, [players[1].id])).rows[0])
      .toMatchObject({ is_alive: false, death_cause: 'hunter_shot' });

    // Shooter's prompt cleared
    expect((await pool.query(`select prompt from room_players where id = $1`, [players[0].id])).rows[0].prompt).toBeNull();

    const duplicate = await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[0].userId, players[2].id],
    );
    expect((duplicate.rows[0] as { apply_hunter_final_shot: { ok: boolean } }).apply_hunter_final_shot.ok).toBe(false);
    expect((await pool.query(`select is_alive from room_players where id = $1`, [players[2].id])).rows[0].is_alive).toBe(true);
  });

  it('publishes victory immediately after the final shot when no follow-up remains', async () => {
    const { roomId, players } = await seedRoom('hunter', 'werewolf');
    await killHunter(roomId, players[0].id);
    await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[0].userId, players[1].id],
    );
    const room = await pool.query(`select status, phase, settings from rooms where id = $1`, [roomId]);
    expect(room.rows[0]).toMatchObject({ status: 'finished', phase: 'finished' });
    expect(room.rows[0].settings.winner).toBe('village');
  });

  it('defers a winning finish until the Hunter shot resolves', async () => {
    const { roomId, players } = await seedRoom('hunter', 'werewolf');
    const claim = randomUUID();
    await pool.query(`update rooms set transition_claim = $2 where id = $1`, [roomId, claim]);

    const deferred = await pool.query(
      `select * from public.finish_game($1, $2, 'village', $3::jsonb, $4::jsonb)`,
      [
        roomId,
        claim,
        JSON.stringify({ aliveWerewolves: 0, aliveNonWerewolves: 1 }),
        JSON.stringify([
          { playerId: players[0].id, cause: 'night_elimination' },
        ]),
      ],
    );
    const deferredBody = (deferred.rows[0] as { finish_game: { ok: boolean; error?: { code?: string } } })
      .finish_game;
    expect(deferredBody.ok).toBe(false);
    expect(deferredBody.error?.code).toBe('death_resolution_pending');
    expect((await pool.query(`select status, phase from rooms where id = $1`, [roomId])).rows[0])
      .toMatchObject({ status: 'in_progress', phase: 'night' });

    await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[0].userId, players[1].id],
    );

    const nextClaim = randomUUID();
    await pool.query(`update rooms set transition_claim = $2 where id = $1`, [roomId, nextClaim]);
    const finished = await pool.query(
      `select * from public.finish_game($1, $2, 'village', $3::jsonb, $4::jsonb)`,
      [
        roomId,
        nextClaim,
        JSON.stringify({ aliveWerewolves: 0, aliveNonWerewolves: 1 }),
        JSON.stringify([]),
      ],
    );
    expect((finished.rows[0] as { finish_game: { ok: boolean } }).finish_game.ok).toBe(true);
    expect((await pool.query(`select status, phase from rooms where id = $1`, [roomId])).rows[0])
      .toMatchObject({ status: 'finished', phase: 'finished' });
  });

  it('expires an overdue prompt without inventing a target', async () => {
    const { roomId, players } = await seedRoom('hunter', 'villager');
    await killHunter(roomId, players[0].id);
    await pool.query(
      `update room_players
       set prompt_deadline_at = now() - interval '1 second'
       where id = $1`,
      [players[0].id],
    );

    const recovered = await pool.query(`select * from public.expire_pending_hunter_final_shots($1)`, [roomId]);
    const body = (recovered.rows[0] as { expire_pending_hunter_final_shots: { expired: number } })
      .expire_pending_hunter_final_shots;
    expect(body.expired).toBe(1);

    expect((await pool.query(`select prompt from room_players where id = $1`, [players[0].id])).rows[0].prompt).toBeNull();
    expect((await pool.query(`select is_alive from room_players where id = $1`, [players[1].id])).rows[0].is_alive).toBe(true);
    expect(
      (await pool.query(`select public.room_has_unresolved_prompt($1) as blocked`, [roomId]))
        .rows[0].blocked,
    ).toBe(false);
  });

  it('creates exactly one follow-up prompt when a shot kills another Hunter', async () => {
    const { roomId, players } = await seedRoom('hunter', 'hunter');
    await killHunter(roomId, players[0].id);
    await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[0].userId, players[1].id],
    );

    const pending = await pool.query(
      `select prompt from room_players where id = $1`,
      [players[1].id],
    );
    expect(pending.rows[0].prompt).toMatchObject({ type: 'hunter_final_shot' });

    await pool.query(
      `select * from public.apply_hunter_final_shot($1, $2, $3)`,
      [roomId, players[1].userId, players[2].id],
    );
    const stillPending = await pool.query(
      `select prompt from room_players where id = $1`,
      [players[1].id],
    );
    expect(stillPending.rows[0].prompt).toBeNull();
  });
});
