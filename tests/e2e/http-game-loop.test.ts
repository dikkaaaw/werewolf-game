import { randomUUID } from 'node:crypto';

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/types/database';

/**
 * HTTP end-to-end tests against the REAL route handlers.
 *
 * Nothing here is stubbed: every request goes over TCP to a running Next.js
 * server, through the real auth middleware and the real `POST`/`GET` handlers,
 * carrying a genuine GoTrue-issued session cookie. The service-role client is
 * used ONLY for test setup (creating users, reading DB state to assert on, and
 * expiring a phase) — never to stand in for a player request.
 *
 * Requires an isolated stack:
 *
 *   ./scripts/supastack-local.sh up
 *   eval "$(./scripts/supastack-local.sh env)"
 *   export E2E_BASE_URL=http://127.0.0.1:3100
 *   npm run build && npx next start -H 127.0.0.1 -p 3100
 *   npx vitest run tests/e2e
 *
 * Without these they SKIP — reported as skipped, never as passed.
 */

const BASE_URL = process.env.E2E_BASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = Boolean(BASE_URL && SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const suite = canRun ? describe : describe.skip;

if (!canRun) {
  console.warn(
    '[e2e] skipping: set E2E_BASE_URL, NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. See ' +
      'scripts/supastack-local.sh.',
  );
}

interface Actor {
  userId: string;
  email: string;
  cookie: string;
  playerId: string;
  roleKey: string;
}

interface Json {
  status: number;
  body: Record<string, unknown>;
}

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function api(
  cookie: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<Json> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * Create a real auth user with a password and sign it in through
 * @supabase/ssr, capturing the session cookie the browser would receive.
 *
 * Going through supabase-js is deliberate: it produces the exact cookie
 * encoding (name from the URL host, `base64-` chunked payload) that the
 * server-side client in src/lib/supabase/server.ts expects. Hand-rolling that
 * would risk testing a cookie the app never issues.
 */
async function createActor(label: string): Promise<Actor> {
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.local`;
  const password = 'E2e-Password-1234';

  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);

  let jar: Array<{ name: string; value: string }> = [];
  const client = createServerClient(SUPABASE_URL!, ANON_KEY!, {
    cookies: {
      getAll: () => jar.map(({ name, value }) => ({ name, value })),
      setAll: (list) => {
        jar = list.map(({ name, value }) => ({ name, value }));
      },
    },
  });

  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  if (jar.length === 0) throw new Error(`no session cookie written for ${label}`);

  return {
    userId: data.user.id,
    email,
    cookie: jar.map((c) => `${c.name}=${c.value}`).join('; '),
    playerId: '',
    roleKey: '',
  };
}


/**
 * Build a second, independent five-player room that is already started.
 *
 * Needed for the reveal lifecycle: the main game in this file ends on its first
 * vote (a 3-1 majority eliminates the lone Werewolf), so it never passes
 * through a "dead player while still in progress" state — which is exactly the
 * state the reveal rule must be checked in.
 */
async function createStartedRoom(): Promise<{
  roomId: string;
  actors: Actor[];
}> {
  const roomHost = await createActor('rev-host');
  const created = await api(roomHost.cookie, '/api/rooms', 'POST', {
    displayName: 'RevealHost',
    maxPlayers: 8,
  });
  const room = created.body.roomId as string;
  roomHost.playerId = created.body.playerId as string;

  const rest: Actor[] = [];
  for (let i = 0; i < 4; i++) {
    const actor = await createActor(`rev${i}`);
    const joined = await api(actor.cookie, '/api/rooms/join', 'POST', {
      roomCode: created.body.roomCode as string,
      displayName: `Reveal${i}`,
    });
    actor.playerId = joined.body.playerId as string;
    rest.push(actor);
  }

  const everyone = [roomHost, ...rest];
  for (const actor of everyone) {
    const ready = await api(actor.cookie, `/api/rooms/${room}/ready`, 'POST', {
      isReady: true,
    });
    expect(ready.status).toBe(200);
  }

  const started = await api(roomHost.cookie, `/api/rooms/${room}/start`, 'POST', {
    roles: [
      { roleKey: 'werewolf', roleCount: 1, config: {} },
      { roleKey: 'villager', roleCount: 2, config: {} },
      { roleKey: 'seer', roleCount: 1, config: {} },
      { roleKey: 'guardian_angel', roleCount: 1, config: {} },
    ],
    nightSeconds: 600,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  for (const actor of everyone) {
    const me = await api(actor.cookie, `/api/rooms/${room}/my-role`, 'GET');
    actor.roleKey = me.body.roleKey as string;
    actor.playerId = me.body.playerId as string;
  }

  return { roomId: room, actors: everyone };
}

suite('e2e: HTTP game loop through the real route handlers', () => {
  // Declared, not constructed. `describe.skip` still executes the callback
  // body, so building the client here would throw "supabaseUrl is required"
  // during collection and fail the run even when the suite is meant to skip.
  let admin: SupabaseClient<Database>;
  let roomId = '';
  let roomCode = '';
  const host = { userId: '', email: '', cookie: '', playerId: '', roleKey: '' } as Actor;
  const others: Actor[] = [];

  /** Force the current phase to be overdue, so the next request must advance it. */
  async function expireCurrentPhase(): Promise<void> {
    const { error } = await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', roomId);
    if (error) throw new Error(`expireCurrentPhase: ${error.message}`);
  }

  async function roomRow(): Promise<Record<string, unknown>> {
    const { data, error } = await admin
      .from('rooms')
      .select('status, phase, round_number')
      .eq('id', roomId)
      .single();
    if (error) throw new Error(`roomRow: ${error.message}`);
    return data as Record<string, unknown>;
  }

  beforeAll(async () => {
    admin = adminClient();

    // --- 1. Create room and join room (real HTTP, real sessions) -----------
    const created = await createActor('host');
    Object.assign(host, created);

    const createRes = await api(host.cookie, '/api/rooms', 'POST', {
      displayName: 'Host',
      maxPlayers: 8,
    });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(200);
    roomId = createRes.body.roomId as string;
    roomCode = createRes.body.roomCode as string;
    host.playerId = createRes.body.playerId as string;

    for (let i = 0; i < 4; i++) {
      const actor = await createActor(`p${i}`);
      const joinRes = await api(actor.cookie, '/api/rooms/join', 'POST', {
        roomCode,
        displayName: `Player${i}`,
      });
      expect(joinRes.status, JSON.stringify(joinRes.body)).toBe(200);
      actor.playerId = joinRes.body.playerId as string;
      others.push(actor);
    }

    const everyone = [host, ...others];

    // --- 2. Start a valid four-player game --------------------------------
    for (const actor of everyone) {
      const ready = await api(
        actor.cookie,
        `/api/rooms/${roomId}/ready`,
        'POST',
        { isReady: true },
      );
      expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    }

    const startRes = await api(host.cookie, `/api/rooms/${roomId}/start`, 'POST', {
      // The approved minimum-five composition.
      roles: [
        { roleKey: 'werewolf', roleCount: 1, config: {} },
        { roleKey: 'villager', roleCount: 2, config: {} },
        { roleKey: 'seer', roleCount: 1, config: {} },
        { roleKey: 'guardian_angel', roleCount: 1, config: {} },
      ],
      nightSeconds: 600,
    });
    expect(startRes.status, JSON.stringify(startRes.body)).toBe(200);

    // Learn each player's own role the way the app does: via my-role.
    for (const actor of everyone) {
      const me = await api(actor.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      actor.roleKey = me.body.roleKey as string;
      actor.playerId = me.body.playerId as string;
    }
  });

  it('1. assigned the approved minimum-five composition', () => {
    const everyone = [host, ...others];
    expect(everyone).toHaveLength(5);
    const roles = everyone.map((a) => a.roleKey).sort();
    expect(roles).toEqual(['guardian_angel', 'seer', 'villager', 'villager', 'werewolf']);
    for (const actor of everyone) expect(actor.playerId).toBeTruthy();
  });

  it('9. public snapshots never expose roles, actions or private results', async () => {
    const everyone = [host, ...others];
    for (const actor of everyone) {
      const snap = await api(actor.cookie, `/api/rooms/${roomId}`, 'GET');
      expect(snap.status).toBe(200);
      const serialised = JSON.stringify(snap.body);

      // No role key may appear as a VALUE while the game is running: every
      // player is alive here, so revealedRole must be null for all of them.
      for (const role of ['werewolf', 'seer', 'guardian_angel', 'villager']) {
        expect(serialised, 'snapshot leaked a role key').not.toContain(`"${role}"`);
      }
      // No private tables / columns beyond the single permitted reveal field.
      for (const forbidden of [
        'roleKey',
        'role_key',
        'alignment',
        'investigation',
        'result_payload',
        'player_secrets',
        'game_action_results',
        'targetPlayerId',
      ]) {
        expect(serialised, `snapshot leaked ${forbidden}`).not.toContain(forbidden);
      }

      // Explicit form of the invariant: the reveal field exists but is null for
      // every living player during an active game.
      const room = snap.body.room as { status: string; players: Array<{ isAlive: boolean; revealedRole: unknown }> };
      expect(room.status).toBe('in_progress');
      expect(room.players.every((p) => p.isAlive)).toBe(true);
      for (const p of room.players) {
        expect(p.revealedRole, 'a living player was revealed mid-game').toBeNull();
      }
    }
  });

  it('5. seer results are visible only to the authorised player', async () => {
    const seer = [host, ...others].find((a) => a.roleKey === 'seer')!;

    const before = await api(seer.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
    expect(before.status).toBe(200);
    expect(before.body.investigations).toEqual([]);

    // A non-seer must never receive investigation results, even about others.
    for (const actor of [host, ...others].filter((a) => a.roleKey !== 'seer')) {
      const res = await api(actor.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
      expect(res.body.investigations, 'non-seer saw investigations').toEqual([]);
      // And a non-seer cannot read someone else's private role: the endpoint is
      // owner-scoped, so it always returns the caller's own row.
      expect(res.body.playerId).toBe(actor.playerId);
    }
  });

  it('3. accepts an allowed night action, refuses a disallowed one, and replaces on resubmit', async () => {
    const everyone = [host, ...others];
    const werewolf = everyone.find((a) => a.roleKey === 'werewolf')!;
    const villager = everyone.find((a) => a.roleKey === 'villager')!;
    const seer = everyone.find((a) => a.roleKey === 'seer')!;
    const doctor = everyone.find((a) => a.roleKey === 'guardian_angel')!;

    const victim = villager.playerId;

    // Villagers have no night action at all.
    const bad = await api(villager.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: victim,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const wolfFirst = await api(werewolf.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: victim,
    });
    expect(wolfFirst.status, JSON.stringify(wolfFirst.body)).toBe(200);

    // Re-submitting the same action type replaces rather than appends.
    const alternate = everyone.find(
      (a) => a.playerId !== werewolf.playerId && a.playerId !== victim,
    )!.playerId;
    const wolfSecond = await api(werewolf.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: alternate,
    });
    expect(wolfSecond.status).toBe(200);

    const { data: rows } = await admin
      .from('game_actions')
      .select('target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', 1)
      .eq('actor_player_id', werewolf.playerId)
      .eq('action_type', 'eliminate');
    expect(rows, 're-submit stored a second row').toHaveLength(1);
    expect(rows![0].target_player_id).toBe(alternate);

    // Put the werewolf's kill back on the villager, and have the doctor shield
    // that exact target, so night resolution must produce zero eliminations.
    await api(werewolf.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: victim,
    });
    const protect = await api(doctor.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'protect',
      targetPlayerId: victim,
    });
    expect(protect.status, JSON.stringify(protect.body)).toBe(200);

    const inspect = await api(seer.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'investigate',
      targetPlayerId: werewolf.playerId,
    });
    expect(inspect.status, JSON.stringify(inspect.body)).toBe(200);
  });

  it('7. an expired night advances before the action is processed', async () => {
    expect((await roomRow()).phase).toBe('night');
    await expireCurrentPhase();

    // Any action submission must first resolve the overdue night. The action
    // itself is then legitimately rejected because it is daytime — what we
    // care about is that the phase moved on.
    const anyone = [host, ...others].find((a) => a.roleKey === 'seer')!;
    await api(anyone.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'investigate',
      targetPlayerId: host.playerId,
    });

    const room = await roomRow();
    expect(room.phase, 'expired night did not advance').not.toBe('night');
    expect(room.phase).toBe('day');
  });

  it('4. resolved the night with doctor protection: the shielded player survived', async () => {
    const everyone = [host, ...others];
    const villager = everyone.find((a) => a.roleKey === 'villager')!;
    const werewolf = everyone.find((a) => a.roleKey === 'werewolf')!;

    const { data } = await admin
      .from('room_players')
      .select('is_alive')
      .eq('id', villager.playerId)
      .single();
    expect(
      data!.is_alive,
      'doctor protected the target but it was still eliminated',
    ).toBe(true);

    // The werewolf itself must still be alive and kicking.
    const { data: wolf } = await admin
      .from('room_players')
      .select('is_alive')
      .eq('id', werewolf.playerId)
      .single();
    expect(wolf!.is_alive).toBe(true);
  });

  it('5b. the seer now has a private result; other players still do not', async () => {
    const everyone = [host, ...others];
    const seer = everyone.find((a) => a.roleKey === 'seer')!;

    const res = await api(seer.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
    expect(res.status).toBe(200);
    const investigations = res.body.investigations as Array<{ roundNumber: number }>;
    expect(investigations.length, 'seer has no investigation result').toBeGreaterThan(0);
    expect(investigations[0].roundNumber).toBe(1);

    // Nobody else may see it.
    for (const actor of everyone.filter((a) => a.roleKey !== 'seer')) {
      const other = await api(actor.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
      expect(
        (other.body.investigations as unknown[]).length,
        'a non-seer received investigation results',
      ).toBe(0);
    }
  });

  it('7b. day -> voting advances, and votes are accepted in the voting phase', async () => {
    const everyone = [host, ...others];
    const werewolf = everyone.find((a) => a.roleKey === 'werewolf')!;

    await expireCurrentPhase();
    // Voting request triggers the day -> voting advance. The probe must not be
    // the werewolf, or this is a self-vote (409) and proves nothing.
    const probeVoter = everyone.find((a) => a.roleKey === 'villager')!;
    const probe = await api(probeVoter.cookie, `/api/rooms/${roomId}/votes`, 'POST', {
      targetPlayerId: werewolf.playerId,
    });
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect((await roomRow()).phase).toBe('voting');

    // Village votes the werewolf out 3-1. The werewolf cannot vote for itself,
    // so it votes for the villager.
    const villager = everyone.find((a) => a.roleKey === 'villager')!;
    for (const voter of everyone) {
      const target = voter.playerId === werewolf.playerId ? villager.playerId : werewolf.playerId;
      const res = await api(voter.cookie, `/api/rooms/${roomId}/votes`, 'POST', {
        targetPlayerId: target,
      });
      expect(res.status, `${voter.roleKey} vote failed: ${JSON.stringify(res.body)}`).toBe(200);
    }

    const { data: tally } = await admin
      .from('game_votes')
      .select('target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', 1);
    const forWerewolf = tally!.filter((t) => t.target_player_id === werewolf.playerId).length;
    // Five players: the four non-werewolves all vote for it, and it votes for a
    // villager — a 4-1 majority.
    expect(forWerewolf, 'expected a 4-1 majority for the werewolf').toBe(4);
  });

  it('6. the werewolf vote-out ends the game with the correct final state', async () => {
    const everyone = [host, ...others];
    const werewolf = everyone.find((a) => a.roleKey === 'werewolf')!;

    // The vote is only resolved once the voting phase expires.
    const triggerVoter = everyone.find((a) => a.roleKey === 'villager')!;
    await expireCurrentPhase();
    const trigger = await api(
      triggerVoter.cookie,
      `/api/rooms/${roomId}/votes`,
      'POST',
      { targetPlayerId: werewolf.playerId },
    );
    // Either the room is already finished, or the request advanced and finished it.
    expect(trigger.status).toBeLessThan(500);

    const room = await roomRow();
    expect(room.status, 'room did not finish after the werewolf was eliminated').toBe('finished');
    expect(room.phase).toBe('finished');

    const { data: wolfRow } = await admin
      .from('room_players')
      .select('is_alive, death_cause')
      .eq('id', werewolf.playerId)
      .single();
    expect(wolfRow!.is_alive, 'the eliminated werewolf is still alive').toBe(false);
    expect(wolfRow!.death_cause).toBe('vote_elimination');

    // Everyone else survives.
    for (const actor of everyone.filter((a) => a.playerId !== werewolf.playerId)) {
      const { data } = await admin
        .from('room_players')
        .select('is_alive')
        .eq('id', actor.playerId)
        .single();
      expect(data!.is_alive, `${actor.roleKey} should still be alive`).toBe(true);
    }
  });


  it('9c. an eliminated player is revealed mid-game, living players are not', async () => {
    const { roomId: revealRoom, actors } = await createStartedRoom();
    const werewolf = actors.find((a) => a.roleKey === 'werewolf')!;
    const doctor = actors.find((a) => a.roleKey === 'guardian_angel')!;
    const seer = actors.find((a) => a.roleKey === 'seer')!;

    // Two villagers exist. The werewolf will kill ONE of them; call that player
    // `killed` throughout. It must not be the target of the doctor's shield,
    // otherwise the kill is cancelled and there is no eliminated player to
    // reveal.
    const villagers = actors.filter((a) => a.roleKey === 'villager');
    expect(villagers).toHaveLength(2);
    const [killed, spared] = villagers;

    const kill = await api(werewolf.cookie, `/api/rooms/${revealRoom}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: killed.playerId,
    });
    expect(kill.status, JSON.stringify(kill.body)).toBe(200);

    const shield = await api(doctor.cookie, `/api/rooms/${revealRoom}/actions`, 'POST', {
      actionType: 'protect',
      targetPlayerId: seer.playerId,
    });
    expect(shield.status, JSON.stringify(shield.body)).toBe(200);

    // Expire the night; the next request resolves it.
    await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', revealRoom);
    await api(seer.cookie, `/api/rooms/${revealRoom}/actions`, 'POST', {
      actionType: 'investigate',
      targetPlayerId: werewolf.playerId,
    });

    // The victim is dead and the game is STILL RUNNING.
    const { data: roomState } = await admin
      .from('rooms')
      .select('status')
      .eq('id', revealRoom)
      .single();
    expect(roomState!.status).toBe('in_progress');

    const { data: deadRow } = await admin
      .from('room_players')
      .select('is_alive')
      .eq('id', killed.playerId)
      .single();
    expect(deadRow!.is_alive, 'the night kill did not land').toBe(false);

    // The shield genuinely mattered: the protected player is still alive.
    const { data: sparedRow } = await admin
      .from('room_players')
      .select('is_alive')
      .eq('id', seer.playerId)
      .single();
    expect(sparedRow!.is_alive).toBe(true);

    // Now check the public snapshot from every player's perspective.
    for (const actor of actors) {
      const snap = await api(actor.cookie, `/api/rooms/${revealRoom}`, 'GET');
      expect(snap.status).toBe(200);
      const room = snap.body.room as {
        status: string;
        players: Array<{ id: string; isAlive: boolean; revealedRole: unknown }>;
      };
      expect(room.status).toBe('in_progress');

      const deadRowInSnap = room.players.find((p) => p.id === killed.playerId)!;
      expect(deadRowInSnap.revealedRole, 'an eliminated player was not revealed').toBe(
        killed.roleKey,
      );

      // Every living player must still be hidden — including the caller.
      for (const p of room.players.filter((x) => x.isAlive)) {
        expect(p.revealedRole, `living player ${p.id} was revealed mid-game`).toBeNull();
      }

      // Only the one eliminated player carries a role; no other key leaks.
      const revealed = room.players.filter((p) => p.revealedRole !== null);
      expect(revealed).toHaveLength(1);
      expect(revealed[0].id).toBe(killed.playerId);
    }

    // The spared villager is alive and must still be hidden.
    const sparedSnap = await api(spared.cookie, `/api/rooms/${revealRoom}`, 'GET');
    const sparedRow2 = (sparedSnap.body.room as { players: Array<{ id: string; isAlive: boolean; revealedRole: unknown }> })
      .players.find((p) => p.id === spared.playerId)!;
    expect(sparedRow2.isAlive).toBe(true);
    expect(sparedRow2.revealedRole, 'the spared player was revealed').toBeNull();

    // The private role endpoint is unaffected: a living player can still read
    // their own role, and nothing else.
    const seerOwn = await api(seer.cookie, `/api/rooms/${revealRoom}/my-role`, 'GET');
    expect(seerOwn.body.roleKey).toBe('seer');
    expect(seerOwn.body.playerId).toBe(seer.playerId);
  }, 60_000);

  it('9b. a finished game reveals every role publicly', async () => {
    const everyone = [host, ...others];
    for (const actor of everyone) {
      const snap = await api(actor.cookie, `/api/rooms/${roomId}`, 'GET');
      expect(snap.status).toBe(200);
      const room = snap.body.room as {
        status: string;
        players: Array<{ id: string; isAlive: boolean; revealedRole: unknown }>;
      };
      expect(room.status).toBe('finished');

      // At game end every role is public — living players included.
      expect(room.players).toHaveLength(5);
      for (const p of room.players) {
        expect(p.revealedRole, `role withheld at game end for ${p.id}`).not.toBeNull();
      }

      // And they must be the real roles, matching what each player was told.
      const me = await api(actor.cookie, `/api/rooms/${roomId}/my-role`, 'GET');
      const selfRow = room.players.find((p) => p.id === actor.playerId)!;
      expect(selfRow.revealedRole).toBe(me.body.roleKey);
      expect(me.body.roleKey).toBe(actor.roleKey);
    }
  });


  it('10. a non-member gets 404 and cannot trigger phase advancement', async () => {
    // A dedicated room so the assertions below cannot disturb the main game.
    // Its night phase is deliberately expired: if the endpoint ran privileged
    // advancement before checking membership, this request alone would resolve
    // the phase and advance state_version.
    const { roomId: guardedRoom, actors: roomActors } = await createStartedRoom();
    const roomHost = roomActors[0];

    await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', guardedRoom);

    const before = await admin
      .from('rooms')
      .select('status, phase, state_version, transition_claim')
      .eq('id', guardedRoom)
      .single();
    expect(before.data!.phase).toBe('night');

    // An authenticated user who has never joined this room.
    const outsider = await createActor('outsider');

    const res = await api(outsider.cookie, `/api/rooms/${guardedRoom}`, 'GET');
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    // The 404 must not confirm the room exists.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(roomHost.email);

    // The decisive assertion: the request must not have advanced the room.
    const after = await admin
      .from('rooms')
      .select('status, phase, state_version, transition_claim')
      .eq('id', guardedRoom)
      .single();

    expect(after.data!.phase, 'a non-member advanced the phase').toBe(before.data!.phase);
    expect(after.data!.state_version, 'a non-member mutated state_version').toBe(
      before.data!.state_version,
    );
    expect(after.data!.transition_claim).toBe(before.data!.transition_claim);

    // And the outsider learned nothing about the roster.
    expect(body).not.toContain('RevealHost');
    expect(body).not.toContain('roomCode');
  }, 60_000);

  it('10b. a member of one room gets 404 for a different room', async () => {
    // Cross-room isolation over real HTTP: `host` belongs only to the main room
    // and must not be able to read the separate reveal room created above.
    const { roomId: otherRoom } = await createStartedRoom();

    const res = await api(host.cookie, `/api/rooms/${otherRoom}`, 'GET');
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    // ...while still reading its own room fine.
    const own = await api(host.cookie, `/api/rooms/${roomId}`, 'GET');
    expect(own.status).toBe(200);
    expect((own.body.room as { roomCode: string }).roomCode).toBe(roomCode);
  }, 60_000);

  it('10c. a member still triggers lazy advancement for its own expired room', async () => {
    // The counterpart to 10: the fix must gate advancement on membership, not
    // remove it. A member of an expired room still gets it advanced.
    const { roomId: liveRoom, actors: liveActors } = await createStartedRoom();

    await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', liveRoom);

    const before = await admin
      .from('rooms')
      .select('phase, state_version')
      .eq('id', liveRoom)
      .single();
    expect(before.data!.phase).toBe('night');

    // A member of THIS room polls its snapshot; that is the documented trigger.
    const res = await api(liveActors[1].cookie, `/api/rooms/${liveRoom}`, 'GET');
    expect(res.status).toBe(200);

    const after = await admin
      .from('rooms')
      .select('phase, state_version')
      .eq('id', liveRoom)
      .single();

    expect(after.data!.phase, 'a member did not get lazy advancement').toBe('day');
    expect(after.data!.state_version).toBeGreaterThan(before.data!.state_version);
  }, 60_000);

  it('11. a non-member cannot trigger phase advancement via actions or votes', async () => {
    const { roomId: guardedRoom, actors: roomActors } = await createStartedRoom();

    // Expire the night so any advancement would be observable.
    await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', guardedRoom);

    const before = await admin
      .from('rooms')
      .select('phase, state_version, transition_claim')
      .eq('id', guardedRoom)
      .single();
    expect(before.data!.phase).toBe('night');

    const outsider = await createActor('action-outsider');

    const actionRes = await api(outsider.cookie, `/api/rooms/${guardedRoom}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: roomActors[1].playerId,
    });
    expect(actionRes.status, JSON.stringify(actionRes.body)).toBe(404);

    const voteRes = await api(outsider.cookie, `/api/rooms/${guardedRoom}/votes`, 'POST', {
      targetPlayerId: roomActors[1].playerId,
    });
    expect(voteRes.status, JSON.stringify(voteRes.body)).toBe(404);

    // Neither request may have advanced the room.
    const after = await admin
      .from('rooms')
      .select('phase, state_version, transition_claim')
      .eq('id', guardedRoom)
      .single();
    expect(after.data!.phase).toBe(before.data!.phase);
    expect(after.data!.state_version).toBe(before.data!.state_version);
    expect(after.data!.transition_claim).toBe(before.data!.transition_claim);

    // And the 404 must not disclose room or roster contents.
    for (const res of [actionRes, voteRes]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('roomCode');
      expect(body).not.toContain('RevealHost');
    }
  }, 60_000);

  it('11b. actions and votes do not reveal whether an inaccessible room exists', async () => {
    // F5: an existing-but-inaccessible room and a nonexistent room must be
    // indistinguishable, matching the snapshot route's 404.
    const { roomId: otherRoom } = await createStartedRoom();
    const missingRoom = randomUUID();

    const outsider = await createActor('oracle-outsider');
    const otherRoomId = otherRoom;

    const inaccessibleAction = await api(outsider.cookie, `/api/rooms/${otherRoomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: randomUUID(),
    });
    const missingAction = await api(outsider.cookie, `/api/rooms/${missingRoom}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: randomUUID(),
    });
    const inaccessibleVote = await api(outsider.cookie, `/api/rooms/${otherRoomId}/votes`, 'POST', {
      targetPlayerId: randomUUID(),
    });
    const missingVote = await api(outsider.cookie, `/api/rooms/${missingRoom}/votes`, 'POST', {
      targetPlayerId: randomUUID(),
    });

    expect(inaccessibleAction.status).toBe(404);
    expect(missingAction.status).toBe(404);
    expect(inaccessibleVote.status).toBe(404);
    expect(missingVote.status).toBe(404);

    // The bodies must be identical, so no information leaks through shape.
    expect(JSON.stringify(inaccessibleAction.body)).toBe(JSON.stringify(missingAction.body));
    expect(JSON.stringify(inaccessibleVote.body)).toBe(JSON.stringify(missingVote.body));
  }, 60_000);

  it('11c. a member still triggers lazy advancement via actions and votes', async () => {
    // The counterpart to 11: the gate must not remove the feature. A member of
    // an expired room still gets the phase advanced through either endpoint.
    const { roomId: liveRoom, actors: liveActors } = await createStartedRoom();

    await admin
      .from('rooms')
      .update({ phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', liveRoom);

    const before = await admin
      .from('rooms')
      .select('phase, state_version')
      .eq('id', liveRoom)
      .single();
    expect(before.data!.phase).toBe('night');

    // A member submits an action; that is the documented advancement trigger.
    const seer = liveActors.find((a) => a.roleKey === 'seer')!;
    const res = await api(seer.cookie, `/api/rooms/${liveRoom}/actions`, 'POST', {
      actionType: 'investigate',
      targetPlayerId: liveActors.find((a) => a.playerId !== seer.playerId)!.playerId,
    });
    // The request that triggers lazy advancement is judged against the
    // authoritative post-advance state: night is over, so the night action is
    // rejected with 409. The important guarantee is that the phase moved.
    expect(res.status).toBe(409);

    const after = await admin
      .from('rooms')
      .select('phase, state_version')
      .eq('id', liveRoom)
      .single();
    expect(after.data!.phase).toBe('day');
    expect(after.data!.state_version).toBeGreaterThan(before.data!.state_version);

    // And a member voting on a fresh expired room advances day -> voting too.
    const { roomId: voteRoom, actors: voteActors } = await createStartedRoom();
    // Push the game to an expired day phase.
    await admin
      .from('rooms')
      .update({ phase: 'day', phase_ends_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', voteRoom);
    const voteRes = await api(voteActors[1].cookie, `/api/rooms/${voteRoom}/votes`, 'POST', {
      targetPlayerId: voteActors[0].playerId,
    });
    expect(voteRes.status).toBe(200);
    const voteAfter = await admin.from('rooms').select('phase').eq('id', voteRoom).single();
    expect(voteAfter.data!.phase).toBe('voting');
  }, 60_000);

  it('8. dead players cannot act or vote', async () => {
    const everyone = [host, ...others];
    const werewolf = everyone.find((a) => a.roleKey === 'werewolf')!;

    const vote = await api(werewolf.cookie, `/api/rooms/${roomId}/votes`, 'POST', {
      targetPlayerId: host.playerId,
    });
    expect(vote.status).toBeGreaterThanOrEqual(400);

    const action = await api(werewolf.cookie, `/api/rooms/${roomId}/actions`, 'POST', {
      actionType: 'eliminate',
      targetPlayerId: host.playerId,
    });
    expect(action.status).toBeGreaterThanOrEqual(400);
  });

  it('8b. rate limits are enforced on reads', async () => {
    // Dedicated actor so this cannot starve another test's budget.
    const probe = await createActor('ratelimit');
    await api(probe.cookie, '/api/rooms', 'POST', { displayName: 'RateProbe' });

    const codes: number[] = [];
    for (let i = 0; i < 75; i++) {
      const res = await fetch(`${BASE_URL}/api/rooms/${roomId}`, {
        headers: { cookie: probe.cookie },
      });
      codes.push(res.status);
      if (res.status === 429) break;
    }
    expect(codes).toContain(429);
  }, 60_000);

  it('requires a session: no cookie means 401', async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomId}/my-role`);
    expect(res.status).toBe(401);
  });
});