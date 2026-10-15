import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

import { validateRoleConfig } from '@/lib/game/config-validation';
import { assignRoles } from '@/lib/game/role-assignment';
import { resolveNight } from '@/lib/game/night-resolution';
import { resolveVote } from '@/lib/game/vote-resolution';
import { evaluateWinCondition } from '@/lib/game/win-condition';
import type { PlayerState } from '@/lib/game/types';
import type { Database } from '@/types/database';

/**
 * End-to-end integration tests against a real Postgres.
 *
 * These REQUIRE `DATABASE_URL` (direct connection, port 5432) and a migrated
 * database (see supabase/tests/harness.sql + supabase/migrations). Without one
 * they SKIP — reported as skipped, never as passed. A vacuous green suite is
 * worse than an honest skip.
 *
 *   createdb werewolf_test
 *   DATABASE_URL=postgresql://postgres@localhost:5432/werewolf_test \
 *     psql -f supabase/tests/harness.sql -f supabase/migrations/0001_schema.sql ...
 *   DATABASE_URL=... npm test
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = Boolean(DATABASE_URL && SUPABASE_URL && SERVICE_KEY);
const suite = canRun ? describe : describe.skip;

if (!canRun) {
  console.warn(
    '[integration] skipping: set DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY to run these against a real database.',
  );
}

function makeAdmin(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

suite('integration: full game loop against Postgres', () => {
  // Declared, not constructed: the `describe` callback still runs for a
  // skipped suite, so anything that touches the network/env must wait for
  // beforeAll.
  let admin: SupabaseClient<Database>;
  let roomId = '';
  let roomCode = '';
  let hostUserId = '';
  let playerUserIds: string[] = [];
  let playerIds: string[] = [];
  let assignments: Array<{ player_id: string; role_key: string; alignment: string }> = [];

  /**
   * Map a `room_players.id` (seat order) back to the auth user that owns it.
   *
   * Seat 1 is the HOST, because create_room joins the creator before the test
   * joins anyone else. Seats 2..N are `playerUserIds[0..N-2]` in join order.
   * Indexing `playerUserIds` by seat position is off by one and silently returns
   * a user that never joined the room — which surfaces as an unrelated
   * `not_a_member` / `role_not_assigned` rejection.
   */
  function userIdForPlayer(playerId: string): string {
    const seat = playerIds.indexOf(playerId);
    if (seat < 0) throw new Error(`player ${playerId} is not in this room`);
    return seat === 0 ? hostUserId : playerUserIds[seat - 1];
  }

  beforeAll(async () => {
    admin = makeAdmin();
    hostUserId = randomUUID();
    playerUserIds = Array.from({ length: 6 }, () => randomUUID());

    // The RPCs reference auth.users, so create the rows they point at.
    const { error: userError } = await admin.auth.admin.createUser({
      id: hostUserId,
      email: `host-${hostUserId.slice(0, 8)}@test.local`,
    });
    if (userError) throw new Error(`failed to create host user: ${userError.message}`);

    for (const userId of playerUserIds) {
      const { error } = await admin.auth.admin.createUser({
        id: userId,
        email: `p-${userId.slice(0, 8)}@test.local`,
      });
      if (error) throw new Error(`failed to create test user: ${error.message}`);
    }

    const created = await admin.rpc('create_room', {
      p_user_id: hostUserId,
      p_display_name: 'Host',
      p_max_players: 20,
    });
    const createdBody = created.data as {
      ok: boolean;
      roomId?: string;
      roomCode?: string;
      error?: { message: string };
    };
    if (!createdBody.ok) throw new Error(`create_room failed: ${createdBody.error?.message}`);
    roomId = createdBody.roomId!;
    // join_room keys off the 6-character code, not the id. This used to be a
    // literal 'IGNORED', which only ever worked because the suite was skipped.
    roomCode = createdBody.roomCode!;

    for (const userId of playerUserIds) {
      const { data, error } = await admin.rpc('join_room', {
        p_room_code: roomCode,
        p_user_id: userId,
        p_display_name: `Player ${userId.slice(0, 4)}`,
      });
      if (error) throw new Error(`join_room error: ${error.message}`);
      const body = data as { ok: boolean; error?: { message: string } };
      if (!body.ok) throw new Error(`join_room failed: ${body.error?.message}`);
    }
  });

  it('creates a room with the host as seat 1', async () => {
    const { data: room, error } = await admin
      .from('rooms')
      .select('room_code, host_user_id, status, max_players')
      .eq('id', roomId)
      .single();

    expect(error).toBeNull();
    expect(room!.host_user_id).toBe(hostUserId);
    expect(room!.status).toBe('lobby');
    expect(room!.max_players).toBe(20);
    expect(room!.room_code).toMatch(/^[A-Z0-9]{6}$/);

    const { data: roster } = await admin
      .from('room_players')
      .select('id, seat_number, display_name')
      .eq('room_id', roomId)
      .order('seat_number');

    playerIds = roster!.map((r) => r.id);
    expect(playerIds).toHaveLength(7);
    expect(roster![0].seat_number).toBe(1);
  });

  it('assigns roles and flips the room to in_progress', async () => {
    const config = [
      { roleKey: 'werewolf', roleCount: 2, config: {} },
      { roleKey: 'villager', roleCount: 3, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
    ];

    const validation = validateRoleConfig(config, playerIds.length);
    expect(validation.ok).toBe(true);

    const { assignments: dealt } = assignRoles(
      playerIds.map((playerId, index) => ({ playerId, seatNumber: index + 1 })),
      validation.ok ? validation.config : [],
    );

    const { error: cfgError } = await admin.rpc('set_role_config', {
      p_room_id: roomId,
      p_user_id: hostUserId,
      p_entries: config,
    });
    expect(cfgError).toBeNull();

    const { data, error } = await admin.rpc('start_game', {
      p_room_id: roomId,
      p_user_id: hostUserId,
      p_assignments: dealt.map((a) => ({
        playerId: a.playerId,
        roleKey: a.roleKey,
        alignment: a.alignment,
      })),
      p_night_seconds: 600,
    });
    expect(error).toBeNull();

    const body = data as { ok: boolean; error?: { message: string } };
    expect(body.ok, body.error?.message).toBe(true);

    assignments = dealt.map((a) => ({
      player_id: a.playerId,
      role_key: a.roleKey,
      alignment: a.alignment,
    }));

    const { data: room } = await admin
      .from('rooms')
      .select('status, phase, round_number, phase_ends_at')
      .eq('id', roomId)
      .single();

    expect(room!.status).toBe('in_progress');
    expect(room!.phase).toBe('night');
    expect(room!.round_number).toBe(1);
    expect(room!.phase_ends_at).not.toBeNull();
  });

  it('stores exactly one secret per player with a registered role', async () => {
    // Scope to this room's seats: player_secrets has no room_id, so an
    // unscoped select() also returns secrets belonging to other rooms that
    // happen to exist in the same database.
    const { data: secrets, error } = await admin
      .from('player_secrets')
      .select('*')
      .in('player_id', playerIds);
    expect(error).toBeNull();
    expect(secrets).toHaveLength(7);

    for (const secret of secrets!) {
      expect(['werewolf', 'villager', 'seer', 'guardian_angel']).toContain(secret.role_key);
    }
    expect(secrets!.filter((s) => s.role_key === 'werewolf')).toHaveLength(2);
    expect(secrets!.filter((s) => s.role_key === 'seer')).toHaveLength(1);
  });

  it('refuses a duplicate start', async () => {
    const { data } = await admin.rpc('start_game', {
      p_room_id: roomId,
      p_user_id: hostUserId,
      p_assignments: [],
      p_night_seconds: 60,
    });
    const body = data as { ok: boolean; error?: { code: string } };

    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('game_already_started');
  });

  it('accepts a valid night action and rejects an invalid one', async () => {
    const werewolf = assignments.find((a) => a.role_key === 'werewolf')!;
    const villager = assignments.find((a) => a.role_key === 'villager')!;
    const target = assignments.find(
      (a) => a.player_id !== werewolf.player_id && a.role_key !== 'werewolf',
    )!;

    const wasserUserId = userIdForPlayer(werewolf.player_id);
    const villagerUserId = userIdForPlayer(villager.player_id);

    const accepted = await admin.rpc('submit_night_action', {
      p_room_id: roomId,
      p_user_id: wasserUserId,
      p_action_type: 'eliminate',
      p_target_player_id: target.player_id,
    });
    const acceptedBody = accepted.data as { ok: boolean; error?: { message: string } };
    expect(acceptedBody.ok, acceptedBody.error?.message).toBe(true);

    const rejected = await admin.rpc('submit_night_action', {
      p_room_id: roomId,
      p_user_id: villagerUserId,
      p_action_type: 'eliminate',
      p_target_player_id: target.player_id,
    });
    expect((rejected.data as { ok: boolean }).ok).toBe(false);
  });

  it('replaces a repeated action rather than storing a second one', async () => {
    const werewolf = assignments.find((a) => a.role_key === 'werewolf')!;
    const userId = userIdForPlayer(werewolf.player_id);
    const newTarget = assignments.find(
      (a) => a.player_id !== werewolf.player_id && a.role_key !== 'werewolf',
    )!;

    const submitted = await admin.rpc('submit_night_action', {
      p_room_id: roomId,
      p_user_id: userId,
      p_action_type: 'eliminate',
      p_target_player_id: newTarget.player_id,
    });
    const body = submitted.data as { ok: boolean; error?: { message: string } };
    expect(body.ok, body.error?.message).toBe(true);

    const { data: actions } = await admin
      .from('game_actions')
      .select('actor_player_id, target_player_id, action_type')
      .eq('room_id', roomId)
      .eq('round_number', 1)
      .eq('actor_player_id', werewolf.player_id)
      .eq('action_type', 'eliminate');

    expect(actions).toHaveLength(1);
    expect(actions![0].target_player_id).toBe(newTarget.player_id);
  });

  it('resolves the night consistently and records the elimination', async () => {
    const { data: actions } = await admin
      .from('game_actions')
      .select('actor_player_id, action_type, target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', 1);

    const { data: roster } = await admin
      .from('room_players')
      .select('id, seat_number, display_name, is_alive')
      .eq('room_id', roomId);
    const { data: secrets } = await admin
      .from('player_secrets')
      .select('player_id, role_key, alignment')
      .in('player_id', (roster ?? []).map((r) => r.id));

    const states: PlayerState[] = roster!.map((r) => {
      const secret = secrets!.find((s) => s.player_id === r.id)!;
      return {
        playerId: r.id,
        userId: 'u',
        seatNumber: r.seat_number,
        displayName: r.display_name,
        isAlive: r.is_alive,
        alignment: secret.alignment,
        roleKey: secret.role_key,
      };
    });

    const resolved = resolveNight({
      players: states,
      actions: actions!.map((a) => ({
        actorPlayerId: a.actor_player_id,
        actorRoleKey: secrets!.find((s) => s.player_id === a.actor_player_id)!.role_key,
        actionType: a.action_type,
        targetPlayerId: a.target_player_id!,
      })),
    });

    expect(resolved.public.eliminated).toHaveLength(1);

    // Apply through the RPC so the DB stays the source of truth.
    const { data } = await admin.rpc('commit_phase_transition', {
      p_room_id: roomId,
      p_claim: await claimNow(admin, roomId, 'night'),
      p_next_phase: 'day',
      p_round_number: 1,
      p_phase_seconds: 90,
      p_eliminations: resolved.public.eliminated.map((e) => ({
        playerId: e.playerId,
        cause: e.cause,
      })),
      p_events: [
        { eventType: 'day_started', payload: { roundNumber: 1 } },
        {
          eventType: 'player_eliminated',
          payload: { playerId: resolved.public.eliminated[0].playerId },
        },
      ],
    });

    expect((data as { ok: boolean }).ok).toBe(true);

    const { data: after } = await admin
      .from('room_players')
      .select('is_alive')
      .eq('id', resolved.public.eliminated[0].playerId)
      .single();
    expect(after!.is_alive).toBe(false);

    const { data: room } = await admin.from('rooms').select('phase').eq('id', roomId).single();
    expect(room!.phase).toBe('day');
  });

  it('runs an open vote and resolves it', async () => {
    // Move to voting.
    const claim = await claimNow(admin, roomId, 'day');
    await admin.rpc('commit_phase_transition', {
      p_room_id: roomId,
      p_claim: claim,
      p_next_phase: 'voting',
      p_round_number: 1,
      p_phase_seconds: 600,
      p_eliminations: [],
      p_events: [{ eventType: 'voting_started', payload: { roundNumber: 1 } }],
    });

    const { data: roster } = await admin
      .from('room_players')
      .select('id')
      .eq('room_id', roomId)
      .eq('is_alive', true);

    const aliveIds = roster!.map((r) => r.id);
    const [voterId, targetA, targetB] = aliveIds;

    await admin.rpc('cast_vote', {
      p_room_id: roomId,
      p_user_id: userIdForPlayer(voterId),
      p_target_player_id: targetA,
    });

    // Changing the vote must replace, not append.
    await admin.rpc('cast_vote', {
      p_room_id: roomId,
      p_user_id: userIdForPlayer(voterId),
      p_target_player_id: targetB,
    });

    const { data: votes } = await admin
      .from('game_votes')
      .select('voter_player_id, target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', 1);

    expect(votes).toHaveLength(1);
    expect(votes![0].target_player_id).toBe(targetB);

    const result = resolveVote({
      players: aliveIds.map((id, i) => ({
        playerId: id,
        userId: 'u',
        seatNumber: i + 1,
        displayName: `P${i}`,
        isAlive: true,
        alignment: 'village',
        roleKey: 'villager',
      })),
      votes: votes!.map((v) => ({ voterPlayerId: v.voter_player_id, targetPlayerId: v.target_player_id })),
      tieRule: 'none',
    });

    expect(result.eliminated?.playerId).toBe(targetB);
  });

  it('computes a win condition from live database state', async () => {
    const { data: roster } = await admin
      .from('room_players')
      .select('id, is_alive, seat_number')
      .eq('room_id', roomId);
    const { data: secrets } = await admin
      .from('player_secrets')
      .select('player_id, alignment')
      .in('player_id', (roster ?? []).map((r) => r.id));

    const result = evaluateWinCondition(
      roster!.map((r) => ({
        playerId: r.id,
        userId: 'u',
        seatNumber: r.seat_number,
        displayName: 'x',
        isAlive: r.is_alive,
        alignment: secrets!.find((s) => s.player_id === r.id)!.alignment,
        roleKey: 'villager',
      })),
    );

    expect(typeof result.hasWinner).toBe('boolean');
    expect(result.aliveWerewolves + result.aliveNonWerewolves).toBe(roster!.filter((r) => r.is_alive).length);
  });
});

/** Force the room's deadline into the past, then win the transition claim. */
async function claimNow(
  admin: SupabaseClient<Database>,
  roomId: string,
  phase: string,
): Promise<string> {
  await admin
    .from('rooms')
    .update({ phase_ends_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', roomId);

  const { data: room } = await admin
    .from('rooms')
    .select('state_version')
    .eq('id', roomId)
    .single();

  const { data, error } = await admin.rpc('claim_phase_transition', {
    p_room_id: roomId,
    p_expected_version: room!.state_version,
    p_expected_phase: phase,
    p_claim_timeout_seconds: 30,
  });
  if (error) throw new Error(`claim failed: ${error.message}`);

  const body = data as { ok: boolean; claim?: string; error?: { message: string } };
  if (!body.ok) throw new Error(`claim rejected: ${body.error?.message}`);
  return body.claim!;
}
