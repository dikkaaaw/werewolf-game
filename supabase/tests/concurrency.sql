-- ===========================================================================
-- supabase/tests/concurrency.sql — GENUINE concurrency regressions (LOCAL ONLY)
--
-- WHY THIS FILE EXISTS
-- The security suite has a test called "Phase transition claim is exclusive",
-- but it runs two claims back-to-back inside ONE transaction. That proves a
-- second claim is rejected; it CANNOT prove race safety, because a single
-- session always sees its own writes and never contends on a row lock.
--
-- HOW REAL CONTENTION IS ESTABLISHED HERE
--   * Every competing call goes through `dblink`, so it runs on its OWN backend
--     in its OWN transaction — not a sequential call dressed up as one.
--   * Setup is COMMITTED before any remote call. This is essential: a DO block
--     would hold an open transaction, and the dblink backends (different
--     connections) could not see the uncommitted room, version or deadline at
--     all. Every statement below therefore autocommits.
--   * Simultaneous pairs are dispatched with `dblink_send_query` (returns
--     immediately, query still running) and collected afterwards with
--     `dblink_get_result`, so neither call has finished when the other starts.
--   * The overlap window is widened with a `pg_sleep` in the remote FROM clause:
--       select <fn>(...)::text from pg_sleep(0.3)
--     holds each backend inside the statement so both reach the contested row
--     UPDATE at effectively the same instant.
--
-- LOCAL/CI ONLY — never run against a hosted database.
-- ===========================================================================

-- Make the file self-aborting. Without this, a caller who forgets
-- `-v ON_ERROR_STOP=1` on the command line would have psql carry on past a
-- failed safety guard and run the rest of the file anyway.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- SAFETY GUARD — must pass before ANY mutation, including CREATE EXTENSION
-- ---------------------------------------------------------------------------
-- Why this is in the file at all: installing `dblink` into `public` also
-- installs it with PostgreSQL's default EXECUTE-to-PUBLIC grant, which would
-- hand the `authenticated` role arbitrary SQL execution. The only thing
-- standing between that and a shared database was a bash-level PGHOST check in
-- the runner — useless to someone who runs the .sql file directly.
--
-- Properties that matter:
--   * It checks the SERVER address (`inet_server_addr()`), not `PGHOST`. An
--     attacker-controlled environment variable therefore cannot satisfy it.
--   * If the address cannot be established at all — unix socket, or anything
--     unresolved — it FAILS CLOSED rather than assuming "probably local".
--   * The database name must be on an explicit allowlist of the isolated local
--     scratch databases (scripts/db-local.sh default and the supastack e2e
--     database). It is not a pattern and not a prefix.
--   * `create extension` happens INSIDE this block. So even a client that
--     ignores the exception cannot get the extension installed: the work is
--     part of the transaction that the RAISE rolls back.
--
-- Verified by scripts/test-security.sh (assert_concurrency_guard), which runs
-- this file against two disallowed LOCAL shapes and asserts a refusal.
-- ===========================================================================

do $guard$
declare
  v_addr      inet;
  v_db        text := current_database();
  -- Explicit allowlist of isolated local scratch databases. Extend this ONLY
  -- when adding a genuinely local test database.
  v_allowed   text[] := array['werewolf_test', 'werewolf_e2e'];
  v_problems  text[] := '{}';
begin
  v_addr := inet_server_addr();

  if v_addr is null then
    v_problems := array_append(v_problems,
      'server address could not be established (unix-socket or unresolved connection), so locality cannot be proven');
  elsif not (
         v_addr <<= '127.0.0.0/8'::inet
      or v_addr = '::1'::inet
      or v_addr = '::ffff:127.0.0.1'::inet
       ) then
    v_problems := array_append(v_problems,
      format('server address %s is not loopback', v_addr));
  end if;

  if not (v_db = any (v_allowed)) then
    v_problems := array_append(v_problems,
      format('database "%s" is not an approved isolated test database (allowed: %s)',
             v_db, array_to_string(v_allowed, ', ')));
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception
      'concurrency.sql SAFETY GUARD: refusing to run. Nothing was created. Reason(s): %',
      array_to_string(v_problems, '; ');
  end if;

  -- Reached only on loopback + an allowlisted database. Install dblink here so
  -- it is inside the guarded transaction rather than a separate statement.
  execute 'create extension if not exists dblink';
end
$guard$;

-- ---------------------------------------------------------------------------
-- Immediately strip the privileges the extension just brought with it.
--
-- PostgreSQL grants EXECUTE on new extension functions to PUBLIC, and
-- anon/authenticated inherit that. dblink_exec would then be arbitrary SQL for
-- any signed-in client. `postgres` still works for the suite because superuser
-- bypasses privilege checks entirely, so this costs the tests nothing.
-- ---------------------------------------------------------------------------
do $revoke$
declare
  r        record;
  v_granted boolean;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'dblink%'
  loop
    execute format('revoke all on function %s from public', r.sig);
    -- anon/authenticated only exist once the harness has created them.
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', r.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', r.sig);
    end if;
  end loop;

  select bool_and(ok) into v_granted from (
    select has_function_privilege('authenticated', p.oid, 'execute') as ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'dblink%'
  ) t;
end
$revoke$;

-- --- per-session helpers --------------------------------------------------
-- pg_temp objects do not survive across psql invocations, so this file carries
-- its own copies (it runs as a standalone suite).

create or replace function pg_temp.assert_eq(p_got anyelement, p_want anyelement, p_message text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'ASSERTION FAILED: % (expected %, got %)', p_message, p_want, p_got;
  end if;
  raise notice '  ok  %', p_message;
end $$;

create or replace function pg_temp.assert_ne(p_got anyelement, p_unwanted anyelement, p_message text)
returns void language plpgsql as $$
begin
  if p_got is not distinct from p_unwanted then
    raise exception 'ASSERTION FAILED: % (should not be %)', p_message, p_unwanted;
  end if;
  raise notice '  ok  %', p_message;
end $$;

create or replace function pg_temp.uuid(n int)
returns uuid language sql immutable as $$
  select (lpad(to_hex(n), 8, '0') || '-0000-0000-0000-000000000000')::uuid
$$;

-- Roles[] dealt to the room's players in seat order. player_secrets cannot be
-- the source: those rows are created BY start_game.
create or replace function pg_temp.assign(p_room uuid, p_roles text[])
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'playerId', t.id,
           'roleKey',   p_roles[t.ord],
           'alignment', case when p_roles[t.ord] = 'werewolf'
                             then 'werewolf' else 'village' end)
         order by t.ord), '[]'::jsonb)
    from (select rp.id, row_number() over (order by rp.seat_number) as ord
            from public.room_players rp where rp.room_id = p_room) t
$$;

-- Build and start a legal five-player room, and hand back its id. Everything
-- it touches is committed by the time this returns, so dblink can see it.
create or replace function pg_temp.started_room(p_host int)
returns uuid language plpgsql as $$
declare
  v_code text;
  v_room uuid;
begin
  v_code := public.create_room(pg_temp.uuid(p_host), 'Host', 10) ->> 'roomCode';
  perform public.join_room(v_code, pg_temp.uuid(p_host + 1), 'A');
  perform public.join_room(v_code, pg_temp.uuid(p_host + 2), 'B');
  perform public.join_room(v_code, pg_temp.uuid(p_host + 3), 'C');
  perform public.join_room(v_code, pg_temp.uuid(p_host + 4), 'D');
  select id into v_room from public.rooms where room_code = v_code;

  perform public.set_role_config(v_room, pg_temp.uuid(p_host),
    '[{"roleKey":"werewolf","roleCount":1,"config":{}},
      {"roleKey":"seer","roleCount":1,"config":{}},
      {"roleKey":"doctor","roleCount":1,"config":{}},
      {"roleKey":"villager","roleCount":2,"config":{}}]'::jsonb);

  perform public.start_game(v_room, pg_temp.uuid(p_host),
    pg_temp.assign(v_room, array['werewolf','seer','doctor','villager','villager']), 600);

  return v_room;
end $$;

-- Backing auth rows for the synthetic actors (ids 980-1004).
insert into auth.users (id, email)
select pg_temp.uuid(n), format('conc-%s@example.test', n)
  from generate_series(980, 1004) as n
on conflict (id) do nothing;

-- Every dblink connection below is pinned to the local scratch instance. There
-- is no way to point these at anything else without editing this file.
\set dsn 'host=127.0.0.1 port=55432 dbname=werewolf_test user=postgres'

-- ===========================================================================
-- C1: two simultaneous phase claims — exactly one wins.
--
-- claim_phase_transition is optimistic concurrency (`where ... and
-- state_version = p_expected_version`). The argument under test is that the row
-- lock serialises the two UPDATEs and the loser re-reads a moved version and
-- matches zero rows. This test actually contends on that lock.
-- ===========================================================================
\echo '### C1. Two simultaneous claims: exactly one succeeds'

select pg_temp.started_room(980) as room \gset
update public.rooms set phase_ends_at = now() - interval '1 second' where id = :'room';
select state_version as ver from public.rooms where id = :'room' \gset

select dblink_connect('c1', :'dsn');
select dblink_connect('c2', :'dsn');

-- Fire BOTH without waiting for either.
select dblink_send_query('c1', format(
  'select public.claim_phase_transition(%L::uuid, %s, ''night'', 30)::text from pg_sleep(0.3)',
  :'room', :ver));
select dblink_send_query('c2', format(
  'select public.claim_phase_transition(%L::uuid, %s, ''night'', 30)::text from pg_sleep(0.3)',
  :'room', :ver));

select r.j as r1 from dblink_get_result('c1') as r(j text) \gset
select r.j as r2 from dblink_get_result('c2') as r(j text) \gset
select dblink_disconnect('c1');
select dblink_disconnect('c2');

select (((:'r1'::jsonb ->> 'ok') = 'true')::int
      + ((:'r2'::jsonb ->> 'ok') = 'true')::int) as wins \gset
select pg_temp.assert_eq(:wins, 1,
  'exactly one of two simultaneous claims succeeded');

-- The loser must fail for the RIGHT reason, not incidentally.
select (case when (:'r1'::jsonb ->> 'ok') = 'true'
             then (:'r2'::jsonb #>> '{error,code}')
             else (:'r1'::jsonb #>> '{error,code}') end) as loser_code \gset
select pg_temp.assert_eq(:'loser_code'::text, 'claim_failed'::text,
  'the losing claim reports claim_failed');

select (select count(distinct transition_claim)::int
          from public.rooms where id = :'room') as tokens \gset
select pg_temp.assert_eq(:tokens, 1, 'exactly one claim token was minted');

select (select state_version from public.rooms where id = :'room') as ver2 \gset
select pg_temp.assert_eq(:ver2, :ver + 1, 'state_version advanced exactly once');

-- ===========================================================================
-- C2: a stale version loses once another worker has claimed.
--
-- This is what real HTTP requests depend on: each caller reads
-- state_version, then claims using it. If a stale version could still claim,
-- two server instances would both drive the transition.
-- ===========================================================================
\echo '### C2. A stale state_version cannot claim after another worker won'

select pg_temp.started_room(985) as room2 \gset
update public.rooms set phase_ends_at = now() - interval '1 second' where id = :'room2';
select state_version as ver_a from public.rooms where id = :'room2' \gset

select (public.claim_phase_transition(:'room2'::uuid, :ver_a, 'night', 30)) as first \gset
select pg_temp.assert_eq((:'first'::jsonb ->> 'ok'), 'true',
  'the first worker claimed the transition');

-- Worker B still holds version A. It must lose — and it must lose from an
-- independent connection, so this is not just this session seeing its writes.
select dblink_connect('c3', :'dsn');
select (select t.j::jsonb as stale
          from dblink('c3', format(
            'select public.claim_phase_transition(%L::uuid, %s, ''night'', 30)::text',
            :'room2', :ver_a)) as t(j text)) as stale \gset
select dblink_disconnect('c3');

select pg_temp.assert_eq((:'stale'::jsonb #>> '{error,code}'), 'claim_failed',
  'a stale state_version loses the claim from an independent connection');

select (select state_version from public.rooms where id = :'room2') as ver_b \gset
select pg_temp.assert_eq(:ver_b, :ver_a + 1,
  'the stale attempt did not advance state_version');

-- ===========================================================================
-- C3: a claim stolen after timeout invalidates the previous worker.  PRIORITISED
--
-- This is the exact hazard migration 0006 was restructured for. Worker A
-- claims, stalls past the 30s timeout, worker B claims, and then A tries to
-- finish the game with its now-stale claim. Because 0006 performs its
-- authorisation UPDATE *before* touching room_players, A must write NOTHING —
-- no elimination, no room flip, no winner recorded.
-- ===========================================================================
\echo '### C3. A claim stolen after timeout invalidates the old worker entirely'

select pg_temp.started_room(990) as room3 \gset
update public.rooms set phase_ends_at = now() - interval '1 second' where id = :'room3';
select state_version as ver_c from public.rooms where id = :'room3' \gset

-- Worker A claims, then "stalls".
select (public.claim_phase_transition(:'room3'::uuid, :ver_c, 'night', 30) ->> 'claim') as claim_a \gset
select pg_temp.assert_ne(:'claim_a'::uuid, null, 'worker A holds a claim');

-- A's lease expires.
update public.rooms
   set transition_claimed_at = now() - interval '60 seconds' where id = :'room3';

-- Worker B takes over and must receive a DIFFERENT token.
select (public.claim_phase_transition(:'room3'::uuid,
         (select state_version from public.rooms where id = :'room3'), 'night', 30))
       as takeover \gset
select pg_temp.assert_eq((:'takeover'::jsonb ->> 'ok'), 'true',
  'worker B took the expired claim');
select pg_temp.assert_ne((:'takeover'::jsonb ->> 'claim')::uuid, :'claim_a'::uuid,
  'the takeover minted a different claim token');

select (select rp.id from public.room_players rp
          join public.player_secrets ps on ps.player_id = rp.id
         where rp.room_id = :'room3' and ps.role_key = 'werewolf') as target \gset

-- Worker A now tries to finish the game with its stale token, from a SEPARATE
-- backend, carrying a real elimination payload.
select dblink_connect('c4', :'dsn');
select (select t.j::jsonb as stale_finish
          from dblink('c4', format(
            'select public.finish_game(%L::uuid, %L::uuid, ''village'', ''{"aliveWerewolves":0,"aliveNonWerewolves":1}''::jsonb, ''[{"playerId":"%s","cause":"vote_elimination"}]''::jsonb)::text',
            :'room3', :'claim_a', :'target')) as t(j text)) as stale_finish \gset
select dblink_disconnect('c4');

select pg_temp.assert_eq((:'stale_finish'::jsonb #>> '{error,code}'), 'claim_lost',
  'the timed-out worker cannot finish the game');

-- The heart of the 0006 regression: NOTHING was written. Not the player, above
-- all; not the room either.
select (select is_alive from public.room_players where id = :'target') as alive \gset
select pg_temp.assert_eq(:'alive'::boolean, true, 'the stale worker eliminated nobody');

select (select status::text from public.rooms where id = :'room3') as status \gset
select pg_temp.assert_eq(:'status'::text, 'in_progress'::text, 'the stale worker did not finish the room');

-- Asserted inline rather than via \gset: a NULL result leaves the psql variable
-- UNSET, and referencing an unset variable is a syntax error, not a failed
-- assertion.
select pg_temp.assert_eq(
  (select settings->>'winner' from public.rooms where id = :'room3'),
  null::text,
  'the stale worker recorded no winner');

-- The legitimate holder can still finish, and only then is the kill applied.
select (public.finish_game(:'room3'::uuid, (:'takeover'::jsonb ->> 'claim')::uuid, 'village',
         '{"aliveWerewolves":0,"aliveNonWerewolves":1}'::jsonb,
         jsonb_build_array(jsonb_build_object('playerId', :'target'::uuid,
                                              'cause', 'vote_elimination')))
       ->> 'ok') as legit_ok \gset
select pg_temp.assert_eq(:'legit_ok'::text, 'true'::text,
  'the current claim holder can still finish the game');

select (select is_alive from public.room_players where id = :'target') as alive2 \gset
select pg_temp.assert_eq(:'alive2'::boolean, false, 'the valid holder eliminated the werewolf');

-- ===========================================================================
-- C4: two simultaneous finish_game calls with the SAME claim.
--
-- Proves the elimination is applied exactly once: one call commits the win, the
-- other is refused, and died_at is written once rather than reset by the loser
-- re-running the guarded UPDATE.
-- ===========================================================================
\echo '### C4. Duplicate finish_game with one claim writes the elimination once'

select pg_temp.started_room(995) as room4 \gset
update public.rooms set phase_ends_at = now() - interval '1 second' where id = :'room4';
select (public.claim_phase_transition(:'room4'::uuid,
         (select state_version from public.rooms where id = :'room4'), 'night', 30)
       ->> 'claim') as claim4 \gset

select (select rp.id from public.room_players rp
          join public.player_secrets ps on ps.player_id = rp.id
         where rp.room_id = :'room4' and ps.role_key = 'werewolf') as target4 \gset

select dblink_connect('c5', :'dsn');
select dblink_connect('c6', :'dsn');

-- Both fire at once with the SAME claim and the SAME elimination payload.
select dblink_send_query('c5', format(
  'select public.finish_game(%L::uuid, %L::uuid, ''village'', ''{"aliveWerewolves":0,"aliveNonWerewolves":1}''::jsonb, ''[{"playerId":"%s","cause":"vote_elimination"}]''::jsonb)::text from pg_sleep(0.3)',
  :'room4', :'claim4', :'target4'));
select dblink_send_query('c6', format(
  'select public.finish_game(%L::uuid, %L::uuid, ''village'', ''{"aliveWerewolves":0,"aliveNonWerewolves":1}''::jsonb, ''[{"playerId":"%s","cause":"vote_elimination"}]''::jsonb)::text from pg_sleep(0.3)',
  :'room4', :'claim4', :'target4'));

select r.j as f1 from dblink_get_result('c5') as r(j text) \gset
select r.j as f2 from dblink_get_result('c6') as r(j text) \gset
select dblink_disconnect('c5');
select dblink_disconnect('c6');

select (((:'f1'::jsonb ->> 'ok') = 'true')::int
      + ((:'f2'::jsonb ->> 'ok') = 'true')::int) as fwins \gset
select pg_temp.assert_eq(:fwins, 1,
  'exactly one of two simultaneous finish_game calls succeeded');

select (case when (:'f1'::jsonb ->> 'ok') = 'true'
             then (:'f2'::jsonb #>> '{error,code}')
             else (:'f1'::jsonb #>> '{error,code}') end) as floser \gset
select pg_temp.assert_eq(:'floser'::text, 'claim_lost'::text,
  'the losing finish_game reports claim_lost');

select (select is_alive from public.room_players where id = :'target4') as alive4 \gset
select pg_temp.assert_eq(:'alive4'::boolean, false, 'the werewolf is dead');

select (select death_cause::text from public.room_players where id = :'target4') as cause4 \gset
select pg_temp.assert_eq(:'cause4'::text, 'vote_elimination'::text, 'the death cause was recorded once');

select (select died_at from public.room_players where id = :'target4') is not null as has_died \gset
select pg_temp.assert_eq(:'has_died'::boolean, true, 'died_at was set');

select (select count(*)::int from public.game_events
         where room_id = :'room4' and event_type = 'game_finished') as fin_events \gset
select pg_temp.assert_eq(:fin_events, 1,
  'a single game_finished event was written despite the race');

-- ===========================================================================
-- C5: two simultaneous commit_phase_transition calls with the same claim.
--
-- commit_phase_transition advances the phase AND appends public events. Two
-- racing calls must not duplicate the event stream, which would double every
-- "X died tonight" announcement in the client.
-- ===========================================================================
\echo '### C5. Duplicate commit_phase_transition creates no duplicate events'

select pg_temp.started_room(1000) as room5 \gset
update public.rooms set phase_ends_at = now() - interval '1 second' where id = :'room5';
select (public.claim_phase_transition(:'room5'::uuid,
         (select state_version from public.rooms where id = :'room5'), 'night', 30)
       ->> 'claim') as claim5 \gset

select dblink_connect('c7', :'dsn');
select dblink_connect('c8', :'dsn');

select dblink_send_query('c7', format(
  'select public.commit_phase_transition(%L::uuid, %L::uuid, ''day'', 1, 300, ''[]''::jsonb, ''[{"eventType":"day_started","payload":{"roundNumber":1}}]''::jsonb)::text from pg_sleep(0.3)',
  :'room5', :'claim5'));
select dblink_send_query('c8', format(
  'select public.commit_phase_transition(%L::uuid, %L::uuid, ''day'', 1, 300, ''[]''::jsonb, ''[{"eventType":"day_started","payload":{"roundNumber":1}}]''::jsonb)::text from pg_sleep(0.3)',
  :'room5', :'claim5'));

select r.j as c1r from dblink_get_result('c7') as r(j text) \gset
select r.j as c2r from dblink_get_result('c8') as r(j text) \gset
select dblink_disconnect('c7');
select dblink_disconnect('c8');

select (((:'c1r'::jsonb ->> 'ok') = 'true')::int
      + ((:'c2r'::jsonb ->> 'ok') = 'true')::int) as cwins \gset
select pg_temp.assert_eq(:cwins, 1,
  'exactly one of two simultaneous commits succeeded');

select (select phase::text from public.rooms where id = :'room5') as phase5 \gset
select pg_temp.assert_eq(:'phase5'::text, 'day'::text, 'the room advanced to day exactly once');

select (select count(*)::int from public.game_events
         where room_id = :'room5' and event_type = 'day_started') as day_events \gset
select pg_temp.assert_eq(:day_events, 1,
  'exactly one day_started event exists (no duplicated announcement)');

\echo '-> concurrency suite passed'