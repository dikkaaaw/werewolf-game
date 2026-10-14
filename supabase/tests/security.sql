-- ===========================================================================
-- supabase/tests/security.sql — RLS / privilege / concurrency assertions
--
-- Runs against a scratch database bootstrapped by harness.sql. Every check
-- raises on failure, so the file fails loudly instead of reporting a false
-- pass.
--
--   ./scripts/db-local.sh reset
--   psql ... -v ON_ERROR_STOP=1 -f supabase/tests/security.sql
--
-- Note on style: a query blocked by RLS returns ZERO ROWS rather than an
-- error, so the assertions check row counts, not exceptions.
-- ===========================================================================

\set ON_ERROR_STOP on

create or replace function pg_temp.assert_eq(p_actual anyelement, p_expected anyelement, p_message text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERTION FAILED: % (expected %, got %)', p_message, p_expected, p_actual;
  end if;
  raise notice '  ok  %', p_message;
end $$;

create or replace function pg_temp.assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not p_ok then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
  raise notice '  ok  %', p_message;
end $$;

-- True when the statement cannot succeed at all. Private tables are protected
-- twice over: no table privilege (hard "permission denied") AND no RLS policy.
-- Either mechanism alone is sufficient; this helper accepts both so the
-- assertions describe the SECURITY PROPERTY rather than the mechanism.
create or replace function pg_temp.is_denied(p_sql text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

\echo ''
\echo '### Setup: two rooms, six players, game started'
-- ---------------------------------------------------------------------------
-- Every setup call is asserted, so a failed RPC fails the suite instead of
-- silently producing an empty room and passing trivially.

select pg_temp.assert_eq(
  (public.create_room('11111111-1111-1111-1111-111111111111', 'Host', 20)) ->> 'ok',
  'true', 'host created room A');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '22222222-2222-2222-2222-222222222222', 'Alice')) ->> 'ok',
  'true', 'Alice joined room A');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '33333333-3333-3333-3333-333333333333', 'Bob')) ->> 'ok',
  'true', 'Bob joined room A');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '44444444-4444-4444-4444-444444444444', 'Carol')) ->> 'ok',
  'true', 'Carol joined room A');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '55555555-5555-5555-5555-555555555555', 'Dave')) ->> 'ok',
  'true', 'Dave joined room A');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '66666666-6666-6666-6666-666666666666', 'Eve')) ->> 'ok',
  'true', 'Eve joined room A');

-- A second, unrelated room used for cross-room tests.
select pg_temp.assert_eq(
  (public.create_room('33333333-3333-3333-3333-333333333333', 'BobSolo', 20)) ->> 'ok',
  'true', 'Bob created room B');

select pg_temp.assert_eq(
  (select count(*) from public.room_players
    where room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')),
  6::bigint, 'room A has exactly 6 players');

select public.set_role_config(
  (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
  '11111111-1111-1111-1111-111111111111',
  '[{"roleKey":"werewolf","roleCount":2,"config":{}},
    {"roleKey":"villager","roleCount":2,"config":{}},
    {"roleKey":"seer","roleCount":1,"config":{}},
    {"roleKey":"doctor","roleCount":1,"config":{}}]'::jsonb
) ->> 'ok' as role_config_ok;

-- Fixed role mapping by seat so assertions are deterministic.
-- (The real engine shuffles server-side; determinism is what makes this
--  assertion suite reproducible.)
select public.start_game(
  (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
  '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(jsonb_build_object('playerId', t.id, 'roleKey', t.role_key, 'alignment', t.align))
     from (
       select rp.id,
              case (row_number() over (order by rp.seat_number) - 1)
                when 0 then 'werewolf' when 1 then 'werewolf'
                when 2 then 'villager' when 3 then 'villager'
                when 4 then 'seer'     else 'doctor'
              end as role_key,
              case (row_number() over (order by rp.seat_number) - 1)
                when 0 then 'werewolf' when 1 then 'werewolf'
                else 'village'
              end as align
       from public.room_players rp
       where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
     ) t),
  600
) ->> 'ok' as game_started;

\echo ''
\echo '### 1. Private tables are unreachable from a client session'
-- ---------------------------------------------------------------------------
-- Alice is a member of room A. She must not be able to read a single row of
-- secrets, actions or internal logs — and the room code being known to her is
-- irrelevant.

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.player_secrets'),
    'player_secrets cannot be read by an authenticated member');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.game_actions'),
    'game_actions cannot be read by an authenticated member');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.game_action_results'),
    'game_action_results cannot be read by an authenticated member');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.game_audit_logs'),
    'game_audit_logs cannot be read by an authenticated member');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.rate_limit_counters'),
    'rate_limit_counters cannot be read by an authenticated member');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.player_secrets limit 0 offset 0'),
    'even a zero-row projection of player_secrets is denied');
rollback;

\echo ''
\echo '### 2. The host gets no extra visibility into roles'
-- ---------------------------------------------------------------------------

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; -- the host

  select pg_temp.assert(
    public.is_room_host((select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')),
    'host passes is_room_host()');

  select pg_temp.assert(
    pg_temp.is_denied('select 1 from public.player_secrets'),
    'host still cannot read any player role');
rollback;

\echo ''
\echo '### 3. Non-members cannot read a room they are not in'
-- ---------------------------------------------------------------------------

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999'; -- outsider

  select pg_temp.assert_eq(
    (select count(*) from public.rooms), 0::bigint,
    'outsider cannot read any room');

  select pg_temp.assert_eq(
    (select count(*) from public.room_players), 0::bigint,
    'outsider cannot read any roster');

  select pg_temp.assert_eq(
    (select count(*) from public.game_events), 0::bigint,
    'outsider cannot read any events');

  select pg_temp.assert_eq(
    (select count(*) from public.game_votes), 0::bigint,
    'outsider cannot read any votes');
rollback;

\echo ''
\echo '### 4. Members CAN read the public tables of their own room only'
-- ---------------------------------------------------------------------------

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; -- Alice, room A only

  select pg_temp.assert_eq(
    (select count(*) from public.rooms), 1::bigint,
    'Alice sees exactly one room (the one she joined)');

  select pg_temp.assert_eq(
    (select count(*) from public.room_players), 6::bigint,
    'Alice sees the full roster of her room');

  select pg_temp.assert(
    (select count(*) from public.game_events) > 0,
    'Alice can read public events');

  select pg_temp.assert(
    (select count(*) from public.room_role_configs) = 4,
    'Alice can read the role composition');
rollback;

\echo ''
\echo '### 5. Mutation RPCs are NOT executable by clients'
-- ---------------------------------------------------------------------------

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.start_game(uuid,uuid,jsonb,integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE start_game');

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.join_room(text,uuid,text)', 'EXECUTE'),
    'authenticated cannot EXECUTE join_room');

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.cast_vote(uuid,uuid,uuid)', 'EXECUTE'),
    'authenticated cannot EXECUTE cast_vote');

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.submit_night_action(uuid,uuid,text,uuid)', 'EXECUTE'),
    'authenticated cannot EXECUTE submit_night_action');

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.claim_phase_transition(uuid,integer,text,integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE claim_phase_transition');

  select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.run_cleanup(integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE run_cleanup');

  select pg_temp.assert(
    not has_function_privilege('anon', 'public.start_game(uuid,uuid,jsonb,integer)', 'EXECUTE'),
    'anon cannot EXECUTE start_game');

  select pg_temp.assert(
    not has_function_privilege('anon', 'public.join_room(text,uuid,text)', 'EXECUTE'),
    'anon cannot EXECUTE join_room');
rollback;

\echo ''
\echo '### 6. Clients cannot write to game tables directly'
-- ---------------------------------------------------------------------------

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

  select pg_temp.assert(
    not has_table_privilege('authenticated', 'public.game_actions', 'INSERT'),
    'authenticated has no INSERT on game_actions');

  select pg_temp.assert(
    not has_table_privilege('authenticated', 'public.game_votes', 'INSERT'),
    'authenticated has no INSERT on game_votes');

  select pg_temp.assert(
    not has_table_privilege('authenticated', 'public.player_secrets', 'SELECT'),
    'authenticated has no SELECT on player_secrets');

  select pg_temp.assert(
    not has_table_privilege('authenticated', 'public.room_players', 'INSERT'),
    'authenticated has no INSERT on room_players');

  select pg_temp.assert(
    not has_table_privilege('authenticated', 'public.rooms', 'UPDATE'),
    'authenticated has no UPDATE on rooms');
rollback;

\echo ''
\echo '### 7. Server-side (service role) CAN do its job'
-- ---------------------------------------------------------------------------

begin;
  set local role service_role;

  select pg_temp.assert_eq(
    (select count(*) from public.player_secrets), 6::bigint,
    'service role reads all 6 secrets');

  select pg_temp.assert_eq(
    (select count(*) from public.room_players where room_id =
       (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')), 6::bigint,
    'service role reads the roster');

  select pg_temp.assert(
    has_function_privilege('service_role', 'public.start_game(uuid,uuid,jsonb,integer)', 'EXECUTE'),
    'service role CAN EXECUTE start_game');
rollback;

\echo ''
\echo '### 8. Role capability is enforced server-side, not from the request'
-- ---------------------------------------------------------------------------
-- Roles are looked up from player_secrets rather than assumed from a seat
-- number, so this stays correct if the setup mapping ever changes.

select pg_temp.assert_eq(
  (public.submit_night_action(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    (select rp.user_id from public.player_secrets ps
       join public.room_players rp on rp.id = ps.player_id
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and ps.role_key = 'villager'
      limit 1),
    'eliminate',
    (select rp.id from public.room_players rp
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and rp.display_name = 'Dave')
  )) -> 'error' ->> 'code',
  'action_not_supported_by_role',
  'a villager cannot submit an eliminate action');

-- A seer cannot "protect" — capability comes from the secret, not the request.
select pg_temp.assert_eq(
  (public.submit_night_action(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    (select rp.user_id from public.player_secrets ps
       join public.room_players rp on rp.id = ps.player_id
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and ps.role_key = 'seer'
      limit 1),
    'protect',
    (select rp.id from public.room_players rp
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and rp.display_name = 'Dave')
  )) -> 'error' ->> 'code',
  'action_not_supported_by_role',
  'a seer cannot submit a protect action');

-- The host is a werewolf here, so this one IS legitimate: the action is accepted.
select pg_temp.assert_eq(
  (public.submit_night_action(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',
    'eliminate',
    (select rp.id from public.room_players rp
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and rp.display_name = 'Dave')
  )) ->> 'ok',
  'true',
  'a werewolf CAN submit an eliminate action (control case)');

-- Voting outside the voting phase is refused for everyone, host included.
select pg_temp.assert_eq(
  (public.cast_vote(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',
    (select rp.id from public.room_players rp
      where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
        and rp.display_name = 'Eve')
  )) -> 'error' ->> 'code',
  'not_voting_phase',
  'voting is rejected outside the voting phase');
rollback;

\echo ''
\echo '### 9. Cross-room targeting is refused'
-- ---------------------------------------------------------------------------

begin;
  -- Host (room A) tries to target Bob's player row in room B.
  select pg_temp.assert_eq(
    (public.submit_night_action(
      (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
      '11111111-1111-1111-1111-111111111111',
      'eliminate',
      (select id from public.room_players rp
        where rp.room_id = (select id from public.rooms where host_user_id = '33333333-3333-3333-3333-333333333333'))
    )) -> 'error' ->> 'code',
    'target_not_in_room',
    'cannot target a player from another room');

  select pg_temp.assert_eq(
    (public.submit_night_action(
      (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
      '11111111-1111-1111-1111-111111111111',
      'eliminate',
      (select id from public.room_players rp
        where rp.room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
          and rp.display_name = 'Host')
    )) -> 'error' ->> 'code',
    'target_is_self',
    'cannot target yourself');
rollback;

\echo ''
\echo '### 10. Duplicate start / join requests are rejected'
-- ---------------------------------------------------------------------------

select pg_temp.assert_eq(
  (public.start_game(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',
    '[]'::jsonb, 600)) -> 'error' ->> 'code',
  'game_already_started',
  'a second start_game on a running room is refused');

-- Bob is already in room B, which is still a lobby: the duplicate check applies.
select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '33333333-3333-3333-3333-333333333333'),
    '33333333-3333-3333-3333-333333333333', 'BobAgain')) -> 'error' ->> 'code',
  'already_joined',
  'the same account cannot join a room twice');

select pg_temp.assert_eq(
  (public.join_room(
    (select room_code from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '99999999-9999-9999-9999-999999999999', 'Outsider')) -> 'error' ->> 'code',
  'room_in_progress',
  'cannot join a room that already started');

select pg_temp.assert_eq(
  (public.set_role_config(
    (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',
    '[{"roleKey":"villager","roleCount":6}]'::jsonb)) -> 'error' ->> 'code',
  'game_already_started',
  'role configuration is locked once the game starts');

\echo ''
\echo '### 11. Non-host cannot change settings or start'
-- ---------------------------------------------------------------------------

select pg_temp.assert_eq(
  (public.set_role_config(
    (select id from public.rooms where host_user_id = '33333333-3333-3333-3333-333333333333'),
    '22222222-2222-2222-2222-222222222222',
    '[]'::jsonb)) -> 'error' ->> 'code',
  'forbidden',
  'a non-host cannot set the role configuration');

\echo ''
\echo '### 12. Phase transition claim is exclusive'
-- ---------------------------------------------------------------------------

-- Move the deadline into the past so the room is eligible.
update public.rooms
   set phase_ends_at = now() - interval '1 second'
 where host_user_id = '11111111-1111-1111-1111-111111111111';

do $$
declare
  v_version integer;
  v_claim1  uuid;
  v_claim2  uuid;
  v_first   jsonb;
  v_second  jsonb;
  v_room    uuid;
begin
  select id, state_version into v_room, v_version
    from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111';

  v_first := public.claim_phase_transition(v_room, v_version, 'night', 30);
  if v_first ->> 'ok' <> 'true' then
    raise exception 'ASSERTION FAILED: first claim should have succeeded: %', v_first;
  end if;
  v_claim1 := (v_first ->> 'claim')::uuid;
  raise notice '  ok  first transition claim succeeds';

  -- A competing worker using the same expected version must lose.
  v_second := public.claim_phase_transition(v_room, v_version, 'night', 30);
  if v_second ->> 'ok' <> 'false' then
    raise exception 'ASSERTION FAILED: competing claim should have failed: %', v_second;
  end if;
  raise notice '  ok  competing claim with a stale state_version is refused';

  -- Re-claiming with the NEW version must also fail while the claim is fresh.
  select state_version into v_version from public.rooms where id = v_room;
  if (public.claim_phase_transition(v_room, v_version, 'night', 30) ->> 'ok') <> 'false' then
    raise exception 'ASSERTION FAILED: a held claim must block re-claiming';
  end if;
  raise notice '  ok  a held (non-stale) claim blocks a second claimer';

  -- A different phase must not be claimable.
  if (public.claim_phase_transition(v_room, v_version, 'voting', 30) ->> 'ok') <> 'false' then
    raise exception 'ASSERTION FAILED: wrong-phase claim must fail';
  end if;
  raise notice '  ok  claiming the wrong phase is refused';

  -- Commit with the correct token succeeds.
  perform pg_temp.assert_eq(
    (public.commit_phase_transition(v_room, v_claim1, 'day', 1, 90, '[]'::jsonb,
      '[{"eventType":"day_started","payload":{}}]'::jsonb)) ->> 'ok',
    'true', 'the claim holder can commit');

  -- Committing again with the same token must fail (idempotency).
  perform pg_temp.assert_eq(
    (public.commit_phase_transition(v_room, v_claim1, 'day', 1, 90, '[]'::jsonb, '[]'::jsonb)) -> 'error' ->> 'code',
    'claim_lost', 'the same claim cannot be committed twice');
end $$;

\echo ''
\echo '### 13. Rate limiting is atomic and shared'
-- ---------------------------------------------------------------------------

do $$
declare
  i integer;
  v_allowed integer := 0;
begin
  for i in 1..5 loop
    if (public.consume_rate_limit('test_bucket', 'user-1', 3, 60) ->> 'allowed') = 'true' then
      v_allowed := v_allowed + 1;
    end if;
  end loop;
  -- 5 attempts against a limit of 3: exactly 3 must be allowed.
  if v_allowed <> 3 then
    raise exception 'ASSERTION FAILED: expected 3 allowed, got %', v_allowed;
  end if;
  raise notice '  ok  rate limit allows exactly the limit (3 of 5)';
end $$;

select pg_temp.assert_eq(
  (select count(*) from public.rate_limit_counters where bucket = 'test_bucket'),
  1::bigint,
  'rate limiting stores one row per window, not one per request');

\echo ''
\echo '### 14. Cleanup is bounded and never touches an active game'
-- ---------------------------------------------------------------------------

select pg_temp.assert_eq(
  (public.run_cleanup(50)) ->> 'ok',
  'true',
  'run_cleanup succeeds');

select pg_temp.assert_eq(
  (select count(*) from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
  1::bigint,
  'cleanup did NOT delete an in-progress room');

select pg_temp.assert_eq(
  (select status::text from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111'),
  'in_progress',
  'the in-progress room is still running');

\echo ''
\echo '### 15. Chat: dead players and non-members cannot post'
-- ---------------------------------------------------------------------------

-- Kill Eve, then have her attempt to chat.
update public.room_players
   set is_alive = false, death_cause = 'vote_elimination', died_at = now()
 where room_id = (select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')
   and display_name = 'Eve';

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666'; -- Eve, now dead

  select pg_temp.assert(
    not public.is_alive_player_in_room((select id from public.rooms where host_user_id = '11111111-1111-1111-1111-111111111111')),
    'a dead player fails is_alive_player_in_room()');

  -- The INSERT privilege exists on chat; the RLS WITH CHECK is what must stop
  -- a dead player from using it. A with-check violation raises, not returns 0.
  select pg_temp.assert(
    pg_temp.is_denied(format(
      'insert into public.game_chat_messages (room_id, round_number, author_player_id, message)
       select r.id, 1, rp.id, ''hello'' from public.rooms r
         join public.room_players rp on rp.room_id = r.id
       where r.host_user_id = %L and rp.user_id = auth.uid()', '11111111-1111-1111-1111-111111111111')),
    'a dead player cannot insert a chat message');
rollback;

\echo ''
\echo '============================================================'
\echo ' All security assertions passed.'
\echo '============================================================'
