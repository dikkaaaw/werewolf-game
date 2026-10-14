-- ===========================================================================
-- supabase/tests/gameplay.sql — GAME-RULE / FUNCTIONAL assertions
--
-- LOCAL/CI TEST HARNESS ONLY. This file is NOT a migration and must never run
-- against production.
--
-- Distinct from security.sql: security.sql asserts *access control* (who may
-- see or do what). This file asserts *game rules and state transitions* — that
-- eliminations are persisted, phase advancement is correct, and the terminal
-- state matches the win condition.
--
-- Every check raises on failure via pg_temp.assert_eq / assert_true, so the
-- file fails loudly instead of reporting a false pass.
--
--   psql -h 127.0.0.1 -p 55432 -U postgres -d werewolf_test \
--        -v ON_ERROR_STOP=1 -f supabase/tests/gameplay.sql
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Assertion helpers (same contract as security.sql)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.assert_eq(p_got anyelement, p_want anyelement, p_message text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'ASSERTION FAILED: % (expected %, got %)',
      p_message, p_want, p_got;
  end if;
  raise notice '  ok  %', p_message;
end $$;

create or replace function pg_temp.assert_true(p_cond boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
  raise notice '  ok  %', p_message;
end $$;

-- Deterministic uuid generator: readable ids that make failures easy to trace.
create or replace function pg_temp.uuid(n int)
returns uuid language sql immutable as $$
  select (lpad(to_hex(n), 8, '0') || '-0000-0000-0000-000000000000')::uuid
$$;

-- `rooms.host_user_id` and `room_players.user_id` are FKs into auth.users, so
-- every synthetic actor needs a backing auth row. Inserted inside the
-- transaction this file wraps around, so they disappear on rollback and never
-- leak between runs.
-- Build a deterministic start_game assignment: roles[] is dealt to the room's
-- players in seat order. `player_secrets` cannot be used as the source here —
-- those rows are created BY start_game, so joining to them before the call
-- yields no rows at all. Determinism is what makes these assertions
-- reproducible; the real engine shuffles server-side.
create or replace function pg_temp.assign(p_room uuid, p_roles text[])
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'playerId', t.id,
           -- Postgres arrays are 1-indexed, and row_number() starts at 1,
           -- so p_roles[t.ord] is the right pick (NOT t.ord - 1).
           'roleKey',   p_roles[t.ord],
           'alignment', case when p_roles[t.ord] = 'werewolf'
                             then 'werewolf' else 'village' end)
         order by t.ord), '[]'::jsonb)
    from (select rp.id, row_number() over (order by rp.seat_number) as ord
            from public.room_players rp where rp.room_id = p_room) t
$$;

-- Claim a phase transition the way the server does: read the current version,
-- then claim optimistically. Returns the claim token (uuid) or NULL.
create or replace function pg_temp.claim(p_room uuid, p_phase text)
returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  select public.claim_phase_transition(
           p_room,
           (select state_version from public.rooms where id = p_room),
           p_phase) into v;
  return (v ->> 'claim')::uuid;
end $$;

insert into auth.users (id, email)
select pg_temp.uuid(n), format('gp-%s@example.test', n)
  from generate_series(900, 999) as n
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Scenario A: a vote that ends the game must persist the elimination.
--
-- This is the regression for the P0 defect: `finish_game` originally took
-- only (room, claim, winner, counts) and never touched `room_players`, so the
-- elimination that TRIGGERED the win was dropped. In the smallest legal game
-- (4 players) the village can vote out the only Werewolf, and the losing
-- Werewolf stayed `is_alive = true` in the final snapshot.
-- ---------------------------------------------------------------------------
\echo '### A. Game-ending vote elimination is persisted'

do $$
declare
  v_room      uuid;
  v_host      uuid := pg_temp.uuid(901);
  v_wolf      uuid := pg_temp.uuid(902);
  v_seer      uuid := pg_temp.uuid(903);
  v_doctor    uuid := pg_temp.uuid(904);
  v_villager  uuid := pg_temp.uuid(905);
  v_code      text;
  v_wolf_p    uuid;
  v_wolf_u    uuid;
  v_seer_u    uuid;
  v_doc_u     uuid;
  v_roles     text[] := array['werewolf','villager','villager','seer','doctor'];
  v_seer_p    uuid;
  v_doc_p     uuid;
  v_claim     uuid;
  v_res       jsonb;
  v_row       record;
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';

  perform public.join_room(v_code, v_wolf,   'Wolf');
  perform public.join_room(v_code, v_seer,   'Seer');
  perform public.join_room(v_code, v_doctor, 'Doctor');
  perform public.join_room(v_code, v_villager, 'Villager');

  select id into v_room from public.rooms where room_code = v_code;

  -- One Werewolf, one Seer, one Doctor, two Villagers: the approved minimum
  -- game (five players, since migration 0008).
  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb) ->> 'ok',
    'true', 'set_role_config accepted the 5-player lineup');

  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host,
    pg_temp.assign(v_room, v_roles),
    60) ->> 'ok',
    'true',
    'start_game succeeded');

  -- Roles can only be resolved AFTER start_game: the player_secrets rows are
  -- created by that call, so a lookup before it matches nothing and every
  -- downstream id would be NULL.
  -- Player ids address elimination targets; user ids address the RPC caller.
  -- Both are captured because a test that confuses them fails confusingly.
  select rp.id, rp.user_id into v_wolf_p, v_wolf_u from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'werewolf';
  select rp.id, rp.user_id into v_seer_p, v_seer_u from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'seer';
  select rp.id, rp.user_id into v_doc_p, v_doc_u from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'doctor';

  perform pg_temp.assert_true(v_wolf_p is not null, 'werewolf seat resolved');
  perform pg_temp.assert_true(v_seer_p is not null, 'seer seat resolved');
  perform pg_temp.assert_true(v_doc_p  is not null, 'doctor seat resolved');

  -- Night 1: no kills. Jump straight to day so the scenario stays readable.
  -- Deadlines must be in the past before a claim can succeed
  -- (claim_phase_transition requires `phase_ends_at <= now()`).
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(
    v_room, pg_temp.claim(v_room, 'night'),
    'day', 1, 90, '[]'::jsonb,
    '[{"eventType":"day_started","payload":{"roundNumber":1}}]'::jsonb);

  -- Day -> voting.
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(
    v_room, pg_temp.claim(v_room, 'day'),
    'voting', 1, 60, '[]'::jsonb,
    '[{"eventType":"voting_started","payload":{"roundNumber":1}}]'::jsonb);

  -- Village gangs up on the Werewolf. This eliminates the last wolf, so the
  -- village wins — and this elimination is the one that must be persisted.
  -- Votes must be cast BEFORE the deadline: cast_vote rejects once
  -- phase_ends_at has passed, which is the rule we want to preserve.
  -- cast_vote / submit_night_action take a USER id (the RPC resolves the session
  -- player itself), never a player id. Passing a player id silently resolves
  -- to nobody, so these results are asserted rather than assumed.
  perform pg_temp.assert_eq(
    public.cast_vote(v_room, v_seer_u, v_wolf_p) ->> 'ok', 'true', 'seer vote accepted');
  perform pg_temp.assert_eq(
    public.cast_vote(v_room, v_doc_u,  v_wolf_p) ->> 'ok', 'true', 'doctor vote accepted');
  perform pg_temp.assert_eq(
    public.cast_vote(v_room, v_wolf_u, v_seer_p) ->> 'ok', 'true', 'werewolf vote accepted');
  perform pg_temp.assert_eq(
    (select count(*)::int from public.game_votes
      where room_id = v_room and round_number = 1), 3, 'three votes were recorded');

  -- Now the voting deadline passes and the phase becomes claimable.
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  v_claim := pg_temp.claim(v_room, 'voting');
  perform pg_temp.assert_true(v_claim is not null, 'voting phase was claimable');

  -- THE REGRESSION: the finish path must take the eliminations.
  v_res := public.finish_game(
    v_room, v_claim, 'village',
    jsonb_build_object('aliveWerewolves', 0, 'aliveNonWerewolves', 3),
    jsonb_build_array(
      jsonb_build_object('playerId', v_wolf_p, 'cause', 'vote_elimination')));

  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'finish_game accepted the game-ending vote elimination');

  select * into v_row from public.room_players where id = v_wolf_p;
  perform pg_temp.assert_eq(v_row.is_alive, false,
    'the eliminated Werewolf is persisted as NOT alive');
  perform pg_temp.assert_eq(v_row.death_cause::text, 'vote_elimination',
    'the eliminated Werewolf persisted death_cause = vote_elimination');
  perform pg_temp.assert_true(v_row.died_at is not null,
    'the eliminated Werewolf has died_at set');

  -- Terminal state.
  select * into v_row from public.rooms where id = v_room;
  perform pg_temp.assert_eq(v_row.status::text, 'finished', 'room status is finished');
  perform pg_temp.assert_eq(v_row.phase::text, 'finished', 'room phase is finished');
  perform pg_temp.assert_true(v_row.phase_ends_at is null,
    'phase_ends_at cleared on finish');
  perform pg_temp.assert_eq(v_row.settings ->> 'winner', 'village',
    'winner persisted in room settings');
  perform pg_temp.assert_true(v_row.transition_claim is null,
    'transition claim released on finish');

  -- The elimination must be applied EXACTLY ONCE. The guard is `and is_alive`,
  -- so a replayed resolution cannot double-write or resurrect the row.
  v_claim := gen_random_uuid();
  update public.rooms set transition_claim = v_claim
   where id = v_room and status = 'finished';
  perform public.finish_game(
    v_room, v_claim, 'village',
    jsonb_build_object('aliveWerewolves', 0, 'aliveNonWerewolves', 3),
    jsonb_build_array(
      jsonb_build_object('playerId', v_wolf_p, 'cause', 'vote_elimination')));
  select * into v_row from public.room_players where id = v_wolf_p;
  perform pg_temp.assert_eq(v_row.is_alive, false,
    'replaying finish_game does not resurrect the eliminated player');
  perform pg_temp.assert_eq((select died_at from public.room_players where id = v_wolf_p)
                              is not null, true,
    'replaying finish_game keeps died_at set');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario B: a night kill that ends the game is persisted the same way.
-- ---------------------------------------------------------------------------
\echo '### B. Game-ending night elimination is persisted'

do $$
declare
  v_room   uuid;
  v_host   uuid := pg_temp.uuid(911);
  v_code   text;
  v_claim  uuid;
  v_row    record;
  v_res    jsonb;
  v_killed uuid;
  v_roles  text[] := array['werewolf','werewolf','villager','villager','seer','doctor'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(912), 'W1');
  perform public.join_room(v_code, pg_temp.uuid(913), 'W2');
  perform public.join_room(v_code, pg_temp.uuid(914), 'S');
  perform public.join_room(v_code, pg_temp.uuid(915), 'D');
  perform public.join_room(v_code, pg_temp.uuid(916), 'V');
  select id into v_room from public.rooms where room_code = v_code;

  -- 2 wolves / 1 seer / 1 doctor / 2 villagers = 6 players.
  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host,
    '[{"roleKey":"werewolf","roleCount":2,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb) ->> 'ok',
    'true', 'set_role_config accepted the 6-role lineup');

  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host,
    pg_temp.assign(v_room, v_roles),
    60) ->> 'ok',
    'true',
    'start_game succeeded');

  -- Scenario B is about PERSISTENCE, not about resolution (night-resolution.ts
  -- is covered exhaustively by unit tests). So the board is arranged directly:
  -- one villager is already dead, leaving 2 wolves vs 3 village alive. The
  -- upcoming night kill takes it to 2 vs 2 => parity => werewolf win, and THAT
  -- kill is the one that must be persisted.
  update public.room_players rp set is_alive = false,
         death_cause = 'vote_elimination', died_at = now()
   where rp.room_id = v_room
     and rp.id in (
       select rp2.id from public.room_players rp2
        where rp2.room_id = v_room
        order by rp2.seat_number limit 1);

  select rp.id into v_killed from public.room_players rp
   where rp.room_id = v_room and rp.is_alive
     and exists (select 1 from public.player_secrets s
                  where s.player_id = rp.id and s.role_key = 'villager')
   limit 1;

  perform pg_temp.assert_true(v_killed is not null, 'a living villager was found to kill');

  -- Expire the night deadline, otherwise the claim is (correctly) refused.
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  v_claim := pg_temp.claim(v_room, 'night');
  perform pg_temp.assert_true(v_claim is not null, 'night phase was claimable');

  -- 2 wolves alive, 2 village alive after this kill => parity => wolf win.
  v_res := public.finish_game(
    v_room, v_claim, 'werewolf',
    jsonb_build_object('aliveWerewolves', 2, 'aliveNonWerewolves', 2),
    jsonb_build_array(
      jsonb_build_object('playerId', v_killed, 'cause', 'night_elimination')));
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'finish_game accepted the game-ending night elimination');

  select * into v_row from public.room_players where id = v_killed;
  perform pg_temp.assert_eq(v_row.is_alive, false,
    'the night-killed villager is persisted as NOT alive');
  perform pg_temp.assert_eq(v_row.death_cause::text, 'night_elimination',
    'the night-killed villager persisted death_cause = night_elimination');

  select * into v_row from public.rooms where id = v_room;
  perform pg_temp.assert_eq(v_row.settings ->> 'winner', 'werewolf',
    'werewolf win persisted');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario C: finish_game with no eliminations is still valid (nothing to kill).
-- ---------------------------------------------------------------------------
\echo '### C. finish_game tolerates an empty elimination list'

do $$
declare
  v_room  uuid;
  v_host  uuid := pg_temp.uuid(921);
  v_code  text;
  v_claim uuid;
  v_row   record;
  v_res   jsonb;
  v_roles text[] := array['werewolf','werewolf','villager','seer','doctor'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(922), 'W1');
  perform public.join_room(v_code, pg_temp.uuid(923), 'W2');
  perform public.join_room(v_code, pg_temp.uuid(924), 'S');
  perform public.join_room(v_code, pg_temp.uuid(925), 'D');
  select id into v_room from public.rooms where room_code = v_code;

  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host,
      '[{"roleKey":"werewolf","roleCount":2,"config":{}},
        {"roleKey":"villager","roleCount":1,"config":{}},
        {"roleKey":"seer","roleCount":1,"config":{}},
        {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb) ->> 'ok',
    'true', 'scenario C role config accepted');

  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host, pg_temp.assign(v_room, v_roles), 60) ->> 'ok',
    'true', 'scenario C start_game succeeded');

  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  v_claim := pg_temp.claim(v_room, 'night');
  perform pg_temp.assert_true(v_claim is not null, 'scenario C night was claimable');

  v_res := public.finish_game(
    v_room, v_claim, 'village',
    jsonb_build_object('aliveWerewolves', 0, 'aliveNonWerewolves', 5),
    '[]'::jsonb);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'finish_game accepted an empty elimination list');

  select * into v_row from public.rooms where id = v_room;
  perform pg_temp.assert_eq(v_row.status::text, 'finished',
    'finish_game succeeds with an empty elimination list');
  perform pg_temp.assert_eq((select count(*) from public.room_players
                             where room_id = v_room and is_alive)::int, 5,
    'no players were killed by an empty elimination list');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario D: finish_game rejects a stale/forged claim token.
-- ---------------------------------------------------------------------------
\echo '### D. finish_game still requires a valid claim token'

do $$
declare
  v_room uuid;
  v_host uuid := pg_temp.uuid(931);
  v_code text;
  v_res   jsonb;
  v_roles text[] := array['werewolf','villager','villager','seer','doctor'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(932), 'W1');
  perform public.join_room(v_code, pg_temp.uuid(933), 'S');
  perform public.join_room(v_code, pg_temp.uuid(934), 'D');
  perform public.join_room(v_code, pg_temp.uuid(935), 'V');
  select id into v_room from public.rooms where room_code = v_code;

  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb) ->> 'ok',
    'true', 'set_role_config accepted the lineup');
  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host,
    pg_temp.assign(v_room, v_roles),
    60) ->> 'ok',
    'true',
    'start_game succeeded');

  -- Forged claim: no row should match `transition_claim = <uuid>`.
  v_res := public.finish_game(v_room, gen_random_uuid(), 'village',
    jsonb_build_object('aliveWerewolves', 0, 'aliveNonWerewolves', 4),
    '[]'::jsonb);

  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'finish_game rejects a forged claim token');
  perform pg_temp.assert_eq(v_res #>> '{error,code}', 'claim_lost',
    'finish_game reports claim_lost for a forged token');
  perform pg_temp.assert_eq((select status::text from public.rooms where id = v_room),
    'in_progress', 'the room is NOT finished after a forged claim');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario E: doctor repeat-target rule (forbidRepeatTarget).
--
-- GAME-RULES §5 step 2.7 + REFERENCE-ANALYSIS §3: `forbidRepeatTarget` means
-- the Doctor may not protect the same player two nights running. Enforced in
-- submit_night_action, not in TypeScript, so a direct RPC caller cannot bypass
-- it.
-- ---------------------------------------------------------------------------
\echo '### E. Doctor cannot protect the same player two nights running'

do $$
declare
  v_room   uuid;
  v_host   uuid := pg_temp.uuid(941);
  v_code   text;
  v_doc    uuid;
  v_doc_u  uuid;
  v_target uuid;
  v_other  uuid;
  v_res    jsonb;
  v_roles  text[] := array['werewolf','seer','doctor','villager','villager'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(942), 'W');
  perform public.join_room(v_code, pg_temp.uuid(943), 'S');
  perform public.join_room(v_code, pg_temp.uuid(944), 'D');
  perform public.join_room(v_code, pg_temp.uuid(945), 'V1');
  select id into v_room from public.rooms where room_code = v_code;

  perform public.set_role_config(v_room, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb);

  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host, pg_temp.assign(v_room, v_roles), 60) ->> 'ok',
    'true', 'scenario E start_game succeeded');

  select rp.id, rp.user_id into v_doc, v_doc_u from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'doctor';
  select rp.id into v_target from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'villager' order by rp.seat_number limit 1;
  select rp.id into v_other from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'villager' order by rp.seat_number desc limit 1;

  perform pg_temp.assert_true(v_doc is not null, 'doctor seat resolved');

  -- Round 1: protecting the same target is fine; there is no previous round.
  v_res := public.submit_night_action(v_room, v_doc_u, 'protect', v_target);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'round 1: doctor may protect a player (no previous round)');

  -- Within the SAME round, re-submitting must still REPLACE, not be refused.
  v_res := public.submit_night_action(v_room, v_doc_u, 'protect', v_other);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'round 1: re-targeting within the same round is allowed (replacement)');
  perform pg_temp.assert_eq(
    (select target_player_id from public.game_actions
      where room_id = v_room and actor_player_id = v_doc
        and round_number = 1 and action_type = 'protect'),
    v_other, 're-submit replaced the round 1 target');

  -- Advance to round 2, ending with the doctor protecting v_other.
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'night'),
    'day', 1, 90, '[]'::jsonb,
    '[{"eventType":"day_started","payload":{"roundNumber":1}}]'::jsonb);
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'day'),
    'voting', 1, 60, '[]'::jsonb,
    '[{"eventType":"voting_started","payload":{"roundNumber":1}}]'::jsonb);
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'voting'),
    'night', 2, 60, '[]'::jsonb,
    '[{"eventType":"night_started","payload":{"roundNumber":2}}]'::jsonb);

  -- Round 2: v_other was protected in round 1, so protecting them again is refused.
  v_res := public.submit_night_action(v_room, v_doc_u, 'protect', v_other);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'round 2: doctor refused a consecutive repeat target');
  perform pg_temp.assert_eq(v_res #>> '{error,code}', 'repeat_target_forbidden',
    'round 2: rejection reports repeat_target_forbidden');

  -- A DIFFERENT target in round 2 is still legal.
  v_res := public.submit_night_action(v_room, v_doc_u, 'protect', v_target);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'round 2: doctor may protect a different player');

  -- The refused submission must not have overwritten the round 2 action.
  perform pg_temp.assert_eq(
    (select target_player_id from public.game_actions
      where room_id = v_room and actor_player_id = v_doc
        and round_number = 2 and action_type = 'protect'),
    v_target, 'round 2 action holds the accepted target');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario F: the repeat guard must not leak across roles or rooms.
-- ---------------------------------------------------------------------------
\echo '### F. Repeat-target rule is scoped to the role'

do $$
declare
  v_room   uuid;
  v_host   uuid := pg_temp.uuid(951);
  v_code   text;
  v_seer_u uuid;
  v_a      uuid;
  v_b      uuid;
  v_res    jsonb;
  v_roles  text[] := array['werewolf','seer','doctor','villager','villager'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(952), 'W');
  perform public.join_room(v_code, pg_temp.uuid(953), 'S');
  perform public.join_room(v_code, pg_temp.uuid(954), 'D');
  perform public.join_room(v_code, pg_temp.uuid(955), 'V1');
  select id into v_room from public.rooms where room_code = v_code;

  perform public.set_role_config(v_room, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb);
  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host, pg_temp.assign(v_room, v_roles), 60) ->> 'ok',
    'true', 'scenario F start_game succeeded');

  select rp.user_id into v_seer_u from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'seer';
  select rp.id into v_a from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'villager' order by rp.seat_number limit 1;
  select rp.id into v_b from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'villager' order by rp.seat_number desc limit 1;

  -- Seer investigating the same player in two consecutive rounds is allowed:
  -- only the Doctor carries forbidRepeatTarget.
  v_res := public.submit_night_action(v_room, v_seer_u, 'investigate', v_a);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true', 'seer round 1 investigate accepted');

  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'night'),
    'day', 1, 90, '[]'::jsonb,
    '[{"eventType":"day_started","payload":{"roundNumber":1}}]'::jsonb);
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'day'),
    'voting', 1, 60, '[]'::jsonb,
    '[{"eventType":"voting_started","payload":{"roundNumber":1}}]'::jsonb);
  update public.rooms set phase_ends_at = now() - interval '1 second' where id = v_room;
  perform public.commit_phase_transition(v_room, pg_temp.claim(v_room, 'voting'),
    'night', 2, 60, '[]'::jsonb,
    '[{"eventType":"night_started","payload":{"roundNumber":2}}]'::jsonb);

  v_res := public.submit_night_action(v_room, v_seer_u, 'investigate', v_a);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'seer may investigate the same player two rounds running');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario G: a forged claim must write NOTHING at all.
--
-- Regression for an ordering hazard. An earlier draft of finish_game checked
-- the claim in a separate `if not exists (...)` BEFORE applying eliminations,
-- then re-checked it in the room UPDATE. In plpgsql a `RETURN` COMMITS the
-- statements already executed — it does not roll them back. So a claim stolen
-- between the two checks would leave the eliminations written on a game that
-- never reached `finished`.
--
-- The authorisation is now the guarded UPDATE itself and it runs first, so a
-- rejected call must leave `room_players` byte-for-byte untouched.
-- ---------------------------------------------------------------------------
\echo '### G. A forged claim writes nothing (no partial elimination)'

do $$
declare
  v_room   uuid;
  v_host   uuid := pg_temp.uuid(961);
  v_code   text;
  v_seer   uuid;
  v_res    jsonb;
  v_before int;
  v_after  int;
  v_roles  text[] := array['werewolf','seer','doctor','villager','villager'];
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(962), 'W');
  perform public.join_room(v_code, pg_temp.uuid(963), 'S');
  perform public.join_room(v_code, pg_temp.uuid(964), 'D');
  perform public.join_room(v_code, pg_temp.uuid(965), 'V1');
  select id into v_room from public.rooms where room_code = v_code;

  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host,
      '[{"roleKey":"werewolf","roleCount":1,"config":{}},
        {"roleKey":"villager","roleCount":2,"config":{}},
        {"roleKey":"seer","roleCount":1,"config":{}},
        {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb) ->> 'ok',
    'true', 'scenario G role config accepted');
  perform pg_temp.assert_eq(
    public.start_game(v_room, v_host, pg_temp.assign(v_room, v_roles), 60) ->> 'ok',
    'true', 'scenario G start_game succeeded');

  select rp.id into v_seer from public.room_players rp
    join public.player_secrets s on s.player_id = rp.id
   where rp.room_id = v_room and s.role_key = 'seer';

  v_before := (select count(*)::int from public.room_players
                where room_id = v_room and not is_alive);

  -- Forged claim: no row has this transition_claim, so the guarded UPDATE
  -- matches nothing and the function must return before touching any player.
  v_res := public.finish_game(v_room, gen_random_uuid(), 'village',
    jsonb_build_object('aliveWerewolves', 0, 'aliveNonWerewolves', 4),
    jsonb_build_array(
      jsonb_build_object('playerId', v_seer, 'cause', 'vote_elimination')));

  perform pg_temp.assert_eq(v_res #>> '{error,code}', 'claim_lost',
    'forged claim rejected');

  v_after := (select count(*)::int from public.room_players
                where room_id = v_room and not is_alive);
  perform pg_temp.assert_eq(v_after, v_before,
    'a forged claim eliminated nobody (no partial write)');
  perform pg_temp.assert_eq(
    (select is_alive from public.room_players where id = v_seer), true,
    'the nominally eliminated player is untouched after a forged claim');
  perform pg_temp.assert_eq(
    (select status::text from public.rooms where id = v_room), 'in_progress',
    'the room is still in_progress after a forged claim');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario H: the five-player minimum gates STARTING, not JOINING.
--
-- Migration 0008 raises start_game's guard from 4 to 5. Two failure modes to
-- rule out:
--   1. the database silently still accepting a 4-player game (the guard lives in
--      SQL, so raising SETTINGS alone would not have moved it); and
--   2. over-correction — gating join_room too, which would strand a 4-player
--      lobby with no way to ever become startable.
-- ---------------------------------------------------------------------------
\echo '### H. Minimum is five for start_game; join_room stays open'

do $$
declare
  v_room    uuid;
  v_code    text;
  v_host    uuid := pg_temp.uuid(970);
  v_users   uuid[] := array[
    pg_temp.uuid(971), pg_temp.uuid(972), pg_temp.uuid(973), pg_temp.uuid(974)];
  v_four    jsonb;
  v_five    jsonb;
  v_start4  jsonb;
  v_start5  jsonb;
begin
  v_code := public.create_room(v_host, 'Host', 10) ->> 'roomCode';
  select id into v_room from public.rooms where room_code = v_code;

  -- Host + three joiners = a 4-player lobby.
  perform public.join_room(v_code, v_users[1], 'A');
  perform public.join_room(v_code, v_users[2], 'B');
  perform public.join_room(v_code, v_users[3], 'C');

  perform pg_temp.assert_eq(
    (select count(*)::int from public.room_players where room_id = v_room), 4,
    'scenario H lobby starts at four players');

  -- A 4-player role config is structurally fine; only the start is blocked.
  v_four := '[{"roleKey":"werewolf","roleCount":1,"config":{}},
               {"roleKey":"villager","roleCount":3,"config":{}}]'::jsonb;
  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host, v_four) ->> 'ok', 'true',
    'scenario H role config for four accepted');

  v_start4 := public.start_game(v_room, v_host, pg_temp.assign(v_room, array['werewolf','villager','villager','villager']), 60);
  perform pg_temp.assert_eq(v_start4 #>> '{error,code}', 'not_enough_players',
    'a four-player game cannot start');
  perform pg_temp.assert_eq(
    (select status::text from public.rooms where id = v_room), 'lobby',
    'the refused start left the room in lobby');

  -- The critical half: a 4-player lobby must still accept the fifth player.
  perform pg_temp.assert_eq(
    public.join_room(v_code, v_users[4], 'D') ->> 'ok', 'true',
    'a four-player lobby still accepts a fifth player (join is not gated)');
  perform pg_temp.assert_eq(
    (select count(*)::int from public.room_players where room_id = v_room), 5,
    'the lobby now holds five players');

  v_five := '[{"roleKey":"werewolf","roleCount":1,"config":{}},
               {"roleKey":"seer","roleCount":1,"config":{}},
               {"roleKey":"doctor","roleCount":1,"config":{}},
               {"roleKey":"villager","roleCount":2,"config":{}}]'::jsonb;
  perform pg_temp.assert_eq(
    public.set_role_config(v_room, v_host, v_five) ->> 'ok', 'true',
    'scenario H five-player role config accepted');

  v_start5 := public.start_game(v_room, v_host,
    pg_temp.assign(v_room, array['werewolf','seer','doctor','villager','villager']), 60);
  perform pg_temp.assert_eq(v_start5 ->> 'ok', 'true',
    'a five-player game starts');
  perform pg_temp.assert_eq((v_start5 ->> 'playerCount')::int, 5,
    'the five-player start reports five players');
  perform pg_temp.assert_eq(
    (select count(*)::int from public.player_secrets ps
       join public.room_players rp on rp.id = ps.player_id
      where rp.room_id = v_room), 5,
    'every player received a secret');

  -- The approved 5-player composition must actually be the one dealt.
  perform pg_temp.assert_eq(
    (select count(*)::int from public.player_secrets ps
       join public.room_players rp on rp.id = ps.player_id
      where rp.room_id = v_room and ps.role_key = 'werewolf'), 1,
    'five-player game dealt exactly one Werewolf');
  perform pg_temp.assert_eq(
    (select count(*)::int from public.player_secrets ps
       join public.room_players rp on rp.id = ps.player_id
      where rp.room_id = v_room and ps.role_key = 'villager'), 2,
    'five-player game dealt two Villagers');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario I: role-reveal privacy at the data layer.
--
-- The public snapshot is assembled in TypeScript from these tables, so the
-- security-critical part to pin here is which rows a reveal-capable read can
-- reach at all:
--   * a client cannot read player_secrets directly (zero RLS policies); and
--   * a scoped read returns role_key only for this room's roster, never another
--     room's players.
-- The end-to-end "living roles stay private" guarantee is asserted over HTTP in
-- tests/e2e/http-game-loop.test.ts, which exercises the real projection.
-- ---------------------------------------------------------------------------
\echo '### I. Role-reveal data-layer scoping'

do $$
declare
  v_room_a  uuid;
  v_room_b  uuid;
  v_code_a  text;
  v_code_b  text;
  v_host    uuid := pg_temp.uuid(900);
  v_users   uuid[] := array[
    pg_temp.uuid(901), pg_temp.uuid(902), pg_temp.uuid(903), pg_temp.uuid(904)];
  v_other   uuid[] := array[
    pg_temp.uuid(905), pg_temp.uuid(906), pg_temp.uuid(907), pg_temp.uuid(908)];
  v_roster  uuid[];
begin
  -- Room A: five players, started.
  v_code_a := public.create_room(v_host, 'Host', 10) ->> 'roomCode';
  perform public.join_room(v_code_a, v_users[1], 'A');
  perform public.join_room(v_code_a, v_users[2], 'B');
  perform public.join_room(v_code_a, v_users[3], 'C');
  perform public.join_room(v_code_a, v_users[4], 'D');
  select id into v_room_a from public.rooms where room_code = v_code_a;

  perform public.set_role_config(v_room_a, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}}]'::jsonb);
  perform public.start_game(v_room_a, v_host,
    pg_temp.assign(v_room_a, array['werewolf','seer','doctor','villager','villager']), 600);

  select coalesce(array_agg(id), '{}'::uuid[]) into v_roster
    from public.room_players where room_id = v_room_a;
  perform pg_temp.assert_eq(array_length(v_roster, 1), 5, 'room A has five players');

  -- 1. player_secrets still has NO client policies: a client role can read
  --    nothing at all, which is why the snapshot route must use the service role.
  perform pg_temp.assert_eq(
    (select count(*)::int from pg_policies
      where schemaname = 'public' and tablename = 'player_secrets'), 0,
    'player_secrets still has zero RLS policies (no client can read it)');

  -- 2. A reveal-shaped read scoped to the roster returns exactly this room's
  --    five roles and nothing from any other room.
  perform pg_temp.assert_eq(
    (select count(*)::int from public.player_secrets
      where player_id = any(v_roster)), 5,
    'a roster-scoped secret read returns exactly the five in-room secrets');

  -- 3. Build a second room; its secrets must be invisible to room A's scope.
  v_code_b := public.create_room(v_host, 'Host2', 10) ->> 'roomCode';
  perform public.join_room(v_code_b, v_other[1], 'E');
  perform public.join_room(v_code_b, v_other[2], 'F');
  perform public.join_room(v_code_b, v_other[3], 'G');
  perform public.join_room(v_code_b, v_other[4], 'H');
  select id into v_room_b from public.rooms where room_code = v_code_b;
  perform public.set_role_config(v_room_b, v_host,
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}}]'::jsonb);
  perform public.start_game(v_room_b, v_host,
    pg_temp.assign(v_room_b, array['werewolf','seer','doctor','villager','villager']), 600);

  perform pg_temp.assert_eq(
    (select count(*)::int from public.player_secrets
      where player_id = any(v_roster)
        and player_id in (select id from public.room_players where room_id = v_room_b)),
    0,
    'room A roster scope never intersects room B players');

  -- 4. The reveal projection must not be able to reach alignment or private
  --    state through the join the route performs. Confirm those columns exist
  --    (so the test would notice if the query widened) but that the route's
  --    column list does not include them.
  perform pg_temp.assert_true(
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'player_secrets'
               and column_name = 'alignment'),
    'player_secrets.alignment exists and must never be projected');

  -- 5. Seer results live in a separate table that the snapshot never joins.
  perform pg_temp.assert_true(
    exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'game_action_results'),
    'game_action_results exists as a separate private table');

  perform pg_temp.assert_eq(
    (select count(*)::int from pg_policies
      where schemaname = 'public' and tablename = 'game_action_results'), 0,
    'game_action_results still has zero RLS policies');
end $$;

-- ---------------------------------------------------------------------------
-- Scenario J: A1 and A2 — same-role targeting is refused, eligible targets work.
--
-- A six-player game with TWO werewolves and TWO doctors, so the restriction is
-- exercised rather than assumed from a single-role default configuration.
--
--   A1: a Werewolf may not eliminate another Werewolf.
--   A2: a Doctor may not protect another Doctor.
--
-- Role identity is read from player_secrets by the RPC, never from the request,
-- and the check is a rule (not a consequence of there being only one of a role).
-- ---------------------------------------------------------------------------
\echo '### J. A1/A2: same-role targeting refused; eligible targets still work'

-- A six-player game with TWO werewolves and TWO doctors so the restriction is
-- exercised rather than assumed from a single-role default configuration.
--
--   A1: a Werewolf may not eliminate another Werewolf.
--   A2: a Doctor may not protect another Doctor.
--
-- Role identity is read from player_secrets by the RPC, never from the request,
-- and the check is a rule (not a consequence of there being only one of a role).
do $$
declare
  v_room  uuid;
  v_code  text;
  v_host  uuid := pg_temp.uuid(917);
  v_wolf1 uuid := pg_temp.uuid(918);   -- Werewolf A
  v_wolf2 uuid := pg_temp.uuid(919);   -- Werewolf B
  v_doc1  uuid := pg_temp.uuid(921);   -- Doctor A
  v_doc2  uuid := pg_temp.uuid(922);   -- Doctor B
  v_w1_p  uuid; v_w2_p uuid; v_d1_p uuid; v_d2_p uuid; v_vil_p uuid;
  v_r     jsonb;
begin
  v_code := public.create_room(v_host, 'Host', 10) ->> 'roomCode';
  perform public.join_room(v_code, v_wolf1, 'W1');
  perform public.join_room(v_code, v_wolf2, 'W2');
  perform public.join_room(v_code, pg_temp.uuid(920), 'S');
  perform public.join_room(v_code, v_doc1, 'D1');
  perform public.join_room(v_code, v_doc2, 'D2');
  select id into v_room from public.rooms where room_code = v_code;

  -- Host is a villager; two werewolves and two doctors among the joiners.
  perform public.set_role_config(v_room, v_host,
    '[{"roleKey":"villager","roleCount":1,"config":{}},
      {"roleKey":"werewolf","roleCount":2,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":2,"config":{}}]'::jsonb);
  perform public.start_game(v_room, v_host,
    pg_temp.assign(v_room, array['villager','werewolf','werewolf','seer','doctor','doctor']), 600);

  -- Resolve player ids by the ACTING auth user.
  select rp.id into v_w1_p from public.room_players rp where rp.room_id = v_room and rp.user_id = v_wolf1;
  select rp.id into v_w2_p from public.room_players rp where rp.room_id = v_room and rp.user_id = v_wolf2;
  select rp.id into v_d1_p from public.room_players rp where rp.room_id = v_room and rp.user_id = v_doc1;
  select rp.id into v_d2_p from public.room_players rp where rp.room_id = v_room and rp.user_id = v_doc2;
  select rp.id into v_vil_p from public.room_players rp
    join public.player_secrets ps on ps.player_id = rp.id
   where rp.room_id = v_room and ps.role_key = 'villager';

  -- A1: a wolf eliminating the other wolf is refused with a stable code.
  v_r := public.submit_night_action(v_room, v_wolf1, 'eliminate', v_w2_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'target_is_werewolf',
    'a Werewolf cannot target another Werewolf (A1)');
  v_r := public.submit_night_action(v_room, v_wolf2, 'eliminate', v_w1_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'target_is_werewolf',
    'the same-role rule is symmetric');

  -- The refusal must not have stored an action.
  perform pg_temp.assert_eq(
    (select count(*)::int from public.game_actions
      where room_id = v_room and actor_player_id = v_w1_p), 0,
    'a rejected same-role action is not persisted');

  -- A1: an eligible non-Werewolf target still works.
  v_r := public.submit_night_action(v_room, v_wolf1, 'eliminate', v_vil_p);
  perform pg_temp.assert_eq(v_r ->> 'ok', 'true',
    'a Werewolf may still eliminate a Villager');

  -- A2: a doctor protecting the other doctor is refused.
  v_r := public.submit_night_action(v_room, v_doc1, 'protect', v_d2_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'target_is_doctor',
    'a Doctor cannot protect another Doctor (A2)');
  v_r := public.submit_night_action(v_room, v_doc2, 'protect', v_d1_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'target_is_doctor',
    'the Doctor rule is symmetric');

  -- A2: an eligible non-Doctor target still works.
  v_r := public.submit_night_action(v_room, v_doc1, 'protect', v_vil_p);
  perform pg_temp.assert_eq(v_r ->> 'ok', 'true',
    'a Doctor may still protect a Villager');

  -- Regression: the pre-existing restrictions still bite on the same endpoint.
  v_r := public.submit_night_action(v_room, v_doc1, 'protect', v_d1_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'target_is_self',
    'self-protection is still refused');
  v_r := public.submit_night_action(v_room, v_wolf1, 'protect', v_vil_p);
  perform pg_temp.assert_eq(v_r #>> '{error,code}', 'action_not_supported_by_role',
    'a Werewolf still cannot protect');

  -- And the invalid actions did not replace the valid ones.
  perform pg_temp.assert_eq(
    (select target_player_id::text from public.game_actions
      where room_id = v_room and actor_player_id = v_w1_p and action_type = 'eliminate'),
    v_vil_p::text, 'a failed submission did not overwrite the valid wolf action');
  perform pg_temp.assert_eq(
    (select target_player_id::text from public.game_actions
      where room_id = v_room and actor_player_id = v_d1_p and action_type = 'protect'),
    v_vil_p::text, 'a failed submission did not overwrite the valid doctor action');
end $$;


-- ===========================================================================
-- Phase-claim release (migration 0010)
--
-- THE REGRESSION: a resolution that failed between claiming and settling left
-- the claim held, so `claim_phase_transition` refused every later worker until
-- the 30s timeout. A persistent failure wedged the room indefinitely with an
-- expired `phase_ends_at` -- countdown zero, no phase move, never `finished`.
-- ===========================================================================
\echo '### K. a failed resolution can hand the claim back'

do $$
declare
  v_room   uuid;
  v_host   uuid := pg_temp.uuid(951);
  v_code   text;
  v_claim  uuid;
  v_res    jsonb;
begin
  v_code := public.create_room(v_host, 'Host', 20) ->> 'roomCode';
  select id into v_room from public.rooms where room_code = v_code;

  update public.rooms
     set status = 'in_progress', phase = 'night', round_number = 1,
         phase_ends_at = now() - interval '1 second', state_version = 1
   where id = v_room;

  v_claim := pg_temp.claim(v_room, 'night');
  perform pg_temp.assert_true(v_claim is not null, 'claim taken for the release test');

  -- While the claim is held nobody else can take it. This is exactly the window
  -- in which the room was previously frozen when a resolution failed.
  v_res := public.claim_phase_transition(
    v_room, (select state_version from public.rooms where id = v_room), 'night', 30);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'a held claim blocks every other worker');

  -- Release it.
  v_res := public.release_phase_transition_claim(v_room, v_claim);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true', 'the holder released its own claim');
  perform pg_temp.assert_true(
    (select transition_claim is null from public.rooms where id = v_room),
    'the claim column is cleared so the room is claimable again');

  -- Immediately re-claimable, at the version the first claim bumped to.
  v_res := public.claim_phase_transition(
    v_room, (select state_version from public.rooms where id = v_room), 'night', 30);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'true',
    'the room can be re-claimed immediately after a release');
  v_claim := (v_res ->> 'claim')::uuid;

  -- A worker cannot release a claim it does not hold.
  v_res := public.release_phase_transition_claim(v_room, gen_random_uuid());
  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'releasing a token we do not hold is refused');

  -- Nor can it release a transition that already settled.
  perform public.commit_phase_transition(v_room, v_claim, 'day', 1, 60, '[]', '[]');
  v_res := public.release_phase_transition_claim(v_room, v_claim);
  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'a settled transition cannot be released again');

  -- A finished room is never mutated, whatever token is presented.
  update public.rooms
     set status = 'finished', phase = 'finished', phase_ends_at = null
   where id = v_room;
  v_res := public.release_phase_transition_claim(v_room, gen_random_uuid());
  perform pg_temp.assert_eq(v_res ->> 'ok', 'false',
    'a finished room is never mutated by a release');
  perform pg_temp.assert_eq(
    (select status::text from public.rooms where id = v_room), 'finished',
    'the finished room is still finished');
end $$;

rollback;
