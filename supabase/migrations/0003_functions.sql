-- ===========================================================================
-- 0003_functions.sql — atomic RPCs
--
-- Every function here is revoked from anon/authenticated in 0002_rls.sql and
-- is therefore reachable only by the service role, i.e. only from server code
-- that has already verified the caller's session.
--
-- Consequence: these functions take the caller's user id as a PARAMETER rather
-- than reading auth.uid(). That is safe precisely because the RPC is not
-- client-callable. Never expose one of these to `authenticated`.
--
-- Every function is a single statement or a single transaction, and returns
-- `jsonb` in the shape `{ ok: true, ... }` or `{ ok: false, error: {...} }`
-- so the API can map failures onto HTTP status codes without parsing text.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Rate limiting (PRD §18.B)
--
-- Atomic upsert against a shared counter table, so the limit holds across all
-- serverless instances. Fixed windows: simple, and one row per window rather
-- than one row per request.
-- ---------------------------------------------------------------------------

create or replace function public.consume_rate_limit(
  p_bucket         text,
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count      integer;
  v_window     timestamptz;
  v_remaining  integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'rate_limit_misconfigured',
      'message', 'Invalid rate limit configuration.'));
  end if;

  insert into public.rate_limit_counters
    (bucket, key, window_started_at, window_seconds, count, updated_at)
  values
    (p_bucket,
     p_key,
     to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds),
     p_window_seconds,
     1,
     now())
  on conflict (bucket, key, window_started_at)
  do update set
    count = public.rate_limit_counters.count + 1,
    updated_at = now()
  returning count, window_started_at into v_count, v_window;

  v_remaining := greatest(p_limit - v_count, 0);

  return jsonb_build_object(
    'ok', true,
    'allowed', v_count <= p_limit,
    'remaining', v_remaining,
    'limit', p_limit,
    'reset_at', (v_window + make_interval(secs => p_window_seconds))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Room membership
-- ---------------------------------------------------------------------------

create or replace function public.create_room(
  p_user_id      uuid,
  p_display_name text,
  p_max_players  integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet   constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 31 symbols, no I/O/0/1
  v_code       text;
  v_room       uuid;
  v_player     uuid;
  v_max        integer;
  v_attempts   integer := 0;
  v_byte       integer;
begin
  v_max := greatest(2, least(coalesce(p_max_players, 20), 20));

  -- Rejection sampling: 31*8 = 248 is the largest multiple of the alphabet size
  -- that fits in a byte, so bytes >= 248 are discarded rather than folded in
  -- with a modulo bias. The retry loop also resolves the (astronomically
  -- unlikely) unique-constraint collision under concurrent creation.
  loop
    v_code := '';
    for i in 1..6 loop
      v_byte := get_byte(gen_random_bytes(1), 0);
      if v_byte >= 248 then
        continue;                       -- reject this character, redraw below
      end if;
      v_code := v_code || substr(v_alphabet, (v_byte % 31) + 1, 1);
    end loop;

    v_attempts := v_attempts + 1;

    exit when length(v_code) = 6;
    exit when v_attempts > 20;          -- give up rather than spin forever
  end loop;

  if length(v_code) <> 6 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'code_generation_failed', 'message', 'Could not allocate a room code.'));
  end if;

  begin
    insert into public.rooms (room_code, host_user_id, max_players, expires_at)
    values (v_code, p_user_id, v_max, now() + interval '2 hours')
    returning id into v_room;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'code_collision', 'message', 'Room code collision; please retry.'));
  end;

  -- The host is an ordinary player and takes seat 1.
  insert into public.room_players (room_id, user_id, display_name, seat_number)
  values (v_room, p_user_id, trim(p_display_name), 1)
  returning id into v_player;

  insert into public.game_events (room_id, event_type, public_payload)
  values (v_room, 'player_joined', jsonb_build_object(
    'playerId', v_player,
    'displayName', trim(p_display_name),
    'seatNumber', 1
  ));

  return jsonb_build_object(
    'ok', true,
    'roomId', v_room,
    'roomCode', v_code,
    'playerId', v_player,
    'seatNumber', 1,
    'maxPlayers', v_max
  );
end;
$$;

create or replace function public.join_room(
  p_room_code   text,
  p_user_id     uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room       public.rooms%rowtype;
  v_player_id  uuid;
  v_seat       integer;
  v_player_count integer;
  v_code       text;
begin
  v_code := upper(trim(p_room_code));

  -- Lock the room row. Concurrent joins serialise here, which is what makes
  -- seat assignment safe without an application-level lock.
  select * into v_room
  from public.rooms
  where room_code = v_code
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'No room with that code.'));
  end if;

  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_in_progress', 'message', 'That game has already started.'));
  end if;

  if v_room.expires_at is not null and v_room.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_expired', 'message', 'That lobby has expired.'));
  end if;

  if exists (select 1 from public.room_players rp
             where rp.room_id = v_room.id and rp.user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'already_joined', 'message', 'You are already in this room.'));
  end if;

  select count(*) into v_player_count from public.room_players rp where rp.room_id = v_room.id;

  if v_player_count >= v_room.max_players then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_full', 'message', 'That room is full.'));
  end if;

  -- Lowest free seat. Safe because of the row lock above plus the unique
  -- (room_id, seat_number) constraint as a backstop.
  select coalesce(min(gap), 1) into v_seat
  from (
    select s as gap
    from generate_series(1, v_room.max_players) as s
    where not exists (
      select 1 from public.room_players rp
      where rp.room_id = v_room.id and rp.seat_number = s
    )
  ) free_seats;

  insert into public.room_players (room_id, user_id, display_name, seat_number)
  values (v_room.id, p_user_id, trim(p_display_name), v_seat)
  returning id into v_player_id;

  update public.rooms
    set last_activity_at = now(),
        expires_at = now() + interval '2 hours',
        state_version = state_version + 1
    where id = v_room.id;

  insert into public.game_events (room_id, event_type, public_payload)
  values (v_room.id, 'player_joined', jsonb_build_object(
    'playerId', v_player_id,
    'displayName', trim(p_display_name),
    'seatNumber', v_seat
  ));

  return jsonb_build_object(
    'ok', true,
    'roomId', v_room.id,
    'roomCode', v_room.room_code,
    'playerId', v_player_id,
    'seatNumber', v_seat,
    'playerCount', v_player_count + 1
  );
end;
$$;

create or replace function public.leave_room(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room    public.rooms%rowtype;
  v_player  public.room_players%rowtype;
  v_host_ok boolean := false;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  select * into v_player from public.room_players rp
   where rp.room_id = p_room_id and rp.user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_a_member', 'message', 'You are not in this room.'));
  end if;

  if v_room.status = 'lobby' then
    delete from public.room_players where id = v_player.id;

    -- Host leaves an empty lobby: transfer to the lowest remaining seat, or
    -- close the room if nobody is left.
    if v_room.host_user_id = p_user_id then
      select rp.user_id into v_host_ok
      from public.room_players rp
      where rp.room_id = p_room_id
      order by rp.seat_number
      limit 1;

      if found then
        update public.rooms set host_user_id = v_host_ok where id = p_room_id;
      else
        update public.rooms
           set status = 'finished', phase = 'finished', phase_ends_at = null,
               expires_at = now() + interval '24 hours',
               state_version = state_version + 1
         where id = p_room_id;
      end if;
    end if;

    insert into public.game_events (room_id, event_type, public_payload)
    values (p_room_id, 'player_left', jsonb_build_object(
      'displayName', v_player.display_name,
      'seatNumber', v_player.seat_number
    ));

    update public.rooms set last_activity_at = now(), state_version = state_version + 1
     where id = p_room_id;

    return jsonb_build_object('ok', true, 'removedFromLobby', true);
  end if;

  -- Mid-game leave: the player is marked dead rather than deleted, so votes,
  -- actions and event history referencing them stay intact and auditable.
  if v_player.is_alive then
    update public.room_players
       set is_alive = false,
           death_cause = 'vote_elimination',
           died_at = now(),
           last_seen_at = now()
     where id = v_player.id;

    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id, 'player_eliminated', jsonb_build_object(
      'playerId', v_player.id,
      'displayName', v_player.display_name,
      'seatNumber', v_player.seat_number,
      'reason', 'left_game'
    ), v_room.round_number);

    update public.rooms set last_activity_at = now(), state_version = state_version + 1
     where id = p_room_id;

    return jsonb_build_object('ok', true, 'removedFromLobby', false, 'markedDead', true);
  end if;

  return jsonb_build_object('ok', true, 'removedFromLobby', false, 'markedDead', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Host role configuration (lobby only)
-- ---------------------------------------------------------------------------

create or replace function public.set_role_config(
  p_room_id  uuid,
  p_user_id  uuid,
  p_entries  jsonb  -- [{"roleKey":"werewolf","roleCount":3,"config":{}}]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms%rowtype;
  v_entry  jsonb;
  v_keys   text[];
  v_player_count integer;
  v_total  integer := 0;
begin
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.host_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'forbidden', 'message', 'Only the host can change the role configuration.'));
  end if;

  -- Locked once the game starts (PRD §3.C).
  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'game_already_started', 'message', 'The role configuration is locked once the game starts.'));
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_config', 'message', 'Expected an array of role entries.'));
  end if;

  select count(*) into v_player_count from public.room_players rp where rp.room_id = p_room_id;

  -- Reject unknown role keys at the database boundary too. The TypeScript
  -- registry is the real gate; this is the backstop that holds even if a new
  -- role is added to the app before the migration that knows about it.
  select coalesce(array_agg(e->>'roleKey'), '{}')
    into v_keys
  from jsonb_array_elements(p_entries) e;

  if exists (
    select 1 from unnest(v_keys) k
    where k not in ('werewolf', 'villager', 'seer', 'doctor')
  ) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'unsupported_role', 'message', 'One or more roles are not supported by the engine.'));
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    if coalesce((v_entry->>'roleCount')::integer, -1) < 0 then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'invalid_config', 'message', 'roleCount must be a non-negative integer.'));
    end if;
    v_total := v_total + (v_entry->>'roleCount')::integer;
  end loop;

  if v_total <> v_player_count then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'role_count_mismatch',
      'message', format('Role counts total %s but there are %s players.', v_total, v_player_count)));
  end if;

  delete from public.room_role_configs where room_id = p_room_id;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    if (v_entry->>'roleCount')::integer > 0 then
      insert into public.room_role_configs (room_id, role_key, role_count, config)
      values (p_room_id,
              v_entry->>'roleKey',
              (v_entry->>'roleCount')::integer,
              coalesce(v_entry->'config', '{}'::jsonb))
      on conflict (room_id, role_key) do update
        set role_count = excluded.role_count, config = excluded.config;
    end if;
  end loop;

  update public.rooms set last_activity_at = now(), state_version = state_version + 1
   where id = p_room_id;

  return jsonb_build_object('ok', true, 'totalRoles', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- Game start
--
-- `p_assignments` is computed by the server-side role-assignment module
-- (which owns the shuffling and is unit-tested); this function only enforces
-- that the assignment matches the live roster before writing it, and writes
-- everything in one transaction so a failure cannot leave a half-started game.
-- ---------------------------------------------------------------------------

create or replace function public.start_game(
  p_room_id     uuid,
  p_user_id     uuid,
  p_assignments jsonb,  -- [{"playerId":"...","roleKey":"villager","alignment":"village"}]
  p_night_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room        public.rooms%rowtype;
  v_player_count integer;
  v_assignment  jsonb;
  v_assigned    integer;
  v_config      jsonb;
  v_role_total  integer;
begin
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.host_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'forbidden', 'message', 'Only the host can start the game.'));
  end if;

  -- Duplicate/concurrent start: the loser of the row lock sees the new state.
  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'game_already_started', 'message', 'The game has already started.'));
  end if;

  select count(*) into v_player_count from public.room_players rp where rp.room_id = p_room_id;

  if v_player_count < 4 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_enough_players',
      'message', format('Need at least 4 players (got %s).', v_player_count)));
  end if;

  select coalesce(sum(role_count), 0) into v_role_total
    from public.room_role_configs where room_id = p_room_id;

  if v_role_total <> v_player_count then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'role_count_mismatch',
      'message', format('Role counts total %s but there are %s players.', v_role_total, v_player_count)));
  end if;

  if not exists (select 1 from public.room_role_configs rc
                  where rc.room_id = p_room_id and rc.role_key = 'werewolf') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'no_werewolf', 'message', 'At least one Werewolf is required.'));
  end if;

  -- Assignment integrity: exactly one entry per roster player, no strangers.
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_assignments', 'message', 'Expected an array of assignments.'));
  end if;

  select count(*) into v_assigned from jsonb_array_elements(p_assignments);

  if v_assigned <> v_player_count then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_assignments',
      'message', format('Received %s assignments for %s players.', v_assigned, v_player_count)));
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_assignments) a
    left join public.room_players rp on rp.id = (a->>'playerId')::uuid and rp.room_id = p_room_id
    where rp.id is null
  ) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_assignments', 'message', 'Assignment references a player outside this room.'));
  end if;

  if (select count(distinct a->>'playerId') from jsonb_array_elements(p_assignments) a) <> v_player_count then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_assignments', 'message', 'A player was assigned more than one role.'));
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_assignments) a
    where a->>'roleKey' not in ('werewolf', 'villager', 'seer', 'doctor')
  ) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'unsupported_role', 'message', 'Assignment contains an unsupported role.'));
  end if;

  -- Persist secrets and the settings snapshot, then flip the room.
  for v_assignment in select * from jsonb_array_elements(p_assignments)
  loop
    insert into public.player_secrets (player_id, role_key, alignment)
    values ((v_assignment->>'playerId')::uuid,
            v_assignment->>'roleKey',
            (v_assignment->>'alignment')::player_alignment)
    on conflict (player_id) do update
      set role_key = excluded.role_key,
          alignment = excluded.alignment,
          assigned_at = now();
  end loop;

  select jsonb_object_agg(role_key, role_count) into v_config
    from public.room_role_configs where room_id = p_room_id;

  update public.rooms
    set status = 'in_progress',
        phase = 'night',
        round_number = 1,
        phase_ends_at = now() + make_interval(secs => greatest(p_night_seconds, 15)),
        settings = settings || jsonb_build_object('roles', coalesce(v_config, '{}'::jsonb)),
        last_activity_at = now(),
        expires_at = now() + interval '24 hours',
        state_version = state_version + 1
    where id = p_room_id;

  insert into public.game_events (room_id, event_type, public_payload, round_number)
  values
    (p_room_id, 'game_started', jsonb_build_object(
       'playerCount', v_player_count,
       'roundNumber', 1,
       'roles', coalesce(v_config, '{}'::jsonb)
     ), 1),
    (p_room_id, 'night_started', jsonb_build_object('roundNumber', 1), 1);

  return jsonb_build_object('ok', true, 'roundNumber', 1, 'playerCount', v_player_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Night actions and votes
--
-- Both validate against live DB state; neither trusts anything the client sent
-- about the world.
-- ---------------------------------------------------------------------------

create or replace function public.submit_night_action(
  p_room_id     uuid,
  p_user_id     uuid,
  p_action_type text,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room     public.rooms%rowtype;
  v_actor    public.room_players%rowtype;
  v_target   public.room_players%rowtype;
  v_secret   public.player_secrets%rowtype;
  v_expected text;
begin
  select * into v_room from public.rooms where id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.status <> 'in_progress' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_in_progress', 'message', 'The game is not running.'));
  end if;

  -- Deadline is server time, always.
  if v_room.phase <> 'night' or v_room.phase_ends_at is null or v_room.phase_ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_night_phase', 'message', 'The night phase is over.'));
  end if;

  select * into v_actor from public.room_players rp
   where rp.room_id = p_room_id and rp.user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_a_member', 'message', 'You are not in this room.'));
  end if;

  if not v_actor.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'player_not_alive', 'message', 'Eliminated players cannot act.'));
  end if;

  select * into v_secret from public.player_secrets where player_id = v_actor.id;

  if not found or v_secret.role_key is null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'role_not_assigned', 'message', 'Your role has not been assigned yet.'));
  end if;

  -- The role's capability comes from the secret table, never from the request.
  select case v_secret.role_key
           when 'werewolf' then 'eliminate'
           when 'seer'     then 'investigate'
           when 'doctor'   then 'protect'
           else null
         end into v_expected;

  if v_expected is null or v_expected <> p_action_type then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'action_not_supported_by_role',
      'message', 'Your role cannot perform that action.'));
  end if;

  select * into v_target from public.room_players rp
   where rp.id = p_target_player_id and rp.room_id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_not_in_room', 'message', 'That player is not in this room.'));
  end if;

  if v_target.id = v_actor.id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_is_self', 'message', 'You cannot target yourself.'));
  end if;

  if not v_target.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_dead', 'message', 'That player has been eliminated.'));
  end if;

  -- One active action per type per round; re-submitting replaces the old one.
  insert into public.game_actions
    (room_id, round_number, actor_player_id, action_type, target_player_id)
  values
    (p_room_id, v_room.round_number, v_actor.id, p_action_type::night_action_type, v_target.id)
  on conflict (room_id, round_number, actor_player_id, action_type)
  do update set target_player_id = excluded.target_player_id, updated_at = now();

  update public.rooms set last_activity_at = now() where id = p_room_id;

  return jsonb_build_object('ok', true, 'roundNumber', v_room.round_number);
end;
$$;

create or replace function public.cast_vote(
  p_room_id     uuid,
  p_user_id     uuid,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms%rowtype;
  v_voter  public.room_players%rowtype;
  v_target public.room_players%rowtype;
begin
  select * into v_room from public.rooms where id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.status <> 'in_progress' or v_room.phase <> 'voting' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_voting_phase', 'message', 'Voting is not open.'));
  end if;

  if v_room.phase_ends_at is null or v_room.phase_ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'phase_expired', 'message', 'Voting has ended.'));
  end if;

  select * into v_voter from public.room_players rp
   where rp.room_id = p_room_id and rp.user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_a_member', 'message', 'You are not in this room.'));
  end if;

  if not v_voter.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'player_not_alive', 'message', 'Eliminated players cannot vote.'));
  end if;

  select * into v_target from public.room_players rp
   where rp.id = p_target_player_id and rp.room_id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_not_in_room', 'message', 'That player is not in this room.'));
  end if;

  if v_target.id = v_voter.id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'vote_for_self', 'message', 'You cannot vote for yourself.'));
  end if;

  if not v_target.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_dead', 'message', 'That player has been eliminated.'));
  end if;

  -- Open voting with changeable choice: exactly one active vote per voter.
  insert into public.game_votes
    (room_id, round_number, voter_player_id, target_player_id)
  values
    (p_room_id, v_room.round_number, v_voter.id, v_target.id)
  on conflict (room_id, round_number, voter_player_id)
  do update set target_player_id = excluded.target_player_id, updated_at = now();

  update public.rooms set last_activity_at = now() where id = p_room_id;

  return jsonb_build_object('ok', true, 'roundNumber', v_room.round_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- Phase transition: claim / commit
--
-- Two-step optimistic protocol documented in docs/IMPLEMENTATION-PLAN.md.
-- The claim is a single conditional UPDATE, so mutual exclusion costs one
-- statement instead of a lock held across the whole resolution.
-- ---------------------------------------------------------------------------

create or replace function public.claim_phase_transition(
  p_room_id           uuid,
  p_expected_version  integer,
  p_expected_phase    text,
  p_claim_timeout_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  update public.rooms r
     set state_version = r.state_version + 1,
         transition_claim = gen_random_uuid(),
         transition_claimed_at = now(),
         updated_at = now()
   where r.id = p_room_id
     and r.status = 'in_progress'
     and r.phase = p_expected_phase::game_phase
     and r.phase_ends_at is not null
     and r.phase_ends_at <= now()
     and r.state_version = p_expected_version
     and (
       r.transition_claim is null
       or r.transition_claimed_at is null
       or r.transition_claimed_at < now() - make_interval(secs => p_claim_timeout_seconds)
     )
  returning * into v_room;

  -- No row: either the deadline has not passed, another worker got there
  -- first, or the version moved. All three mean "do not act".
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_failed',
      'message', 'Phase transition was not claimed (already processed, not expired, or contended).'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'claim', v_room.transition_claim,
    'room', to_jsonb(v_room) - 'transition_claim' - 'transition_claimed_at'
  );
end;
$$;

create or replace function public.commit_phase_transition(
  p_room_id        uuid,
  p_claim          uuid,
  p_next_phase     text,
  p_round_number   integer,
  p_phase_seconds  integer,
  p_eliminations   jsonb,  -- [{"playerId":"...","cause":"night_elimination"}]
  p_events         jsonb   -- [{"eventType":"day_started","payload":{}}]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room        public.rooms%rowtype;
  v_elim        jsonb;
  v_evt         jsonb;
begin
  -- The claim token is the authorisation: only the worker that won the claim
  -- may commit, and only once. A stolen/expired claim silently fails.
  update public.rooms
     set phase = p_next_phase::game_phase,
         round_number = p_round_number,
         phase_ends_at = case
           when p_next_phase in ('night', 'day', 'voting')
             then now() + make_interval(secs => greatest(p_phase_seconds, 15))
           else null
         end,
         status = case when p_next_phase = 'finished' then 'finished' else status end,
         transition_claim = null,
         transition_claimed_at = null,
         last_activity_at = now(),
         updated_at = now()
   where id = p_room_id
     and transition_claim = p_claim
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_lost',
      'message', 'The transition claim was lost or already committed.'));
  end if;

  -- Eliminations, public events and the phase flip all land in one
  -- transaction: a failure here rolls the whole thing back.
  for v_elim in select * from jsonb_array_elements(coalesce(p_eliminations, '[]'::jsonb))
  loop
    update public.room_players rp
       set is_alive = false,
           death_cause = (v_elim->>'cause')::kill_cause,
           died_at = now()
     where rp.id = (v_elim->>'playerId')::uuid
       and rp.room_id = p_room_id
       and rp.is_alive;
  end loop;

  for v_evt in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id,
            (v_evt->>'eventType')::game_event_type,
            coalesce(v_evt->'payload', '{}'::jsonb),
            p_round_number);
  end loop;

  return jsonb_build_object('ok', true, 'phase', v_room.phase, 'roundNumber', v_room.round_number);
end;
$$;

create or replace function public.finish_game(
  p_room_id      uuid,
  p_claim        uuid,
  p_winner       text,
  p_winner_counts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  update public.rooms
     set status = 'finished',
         phase = 'finished',
         phase_ends_at = null,
         transition_claim = null,
         transition_claimed_at = null,
         settings = settings || jsonb_build_object('winner', p_winner),
         expires_at = now() + interval '24 hours',
         last_activity_at = now(),
         updated_at = now()
   where id = p_room_id and transition_claim = p_claim
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_lost', 'message', 'The transition claim was lost or already committed.'));
  end if;

  insert into public.game_events (room_id, event_type, public_payload, round_number)
  values (p_room_id, 'game_finished', jsonb_build_object(
    'winner', p_winner,
    'aliveWerewolves', (p_winner_counts->>'aliveWerewolves')::int,
    'aliveNonWerewolves', (p_winner_counts->>'aliveNonWerewolves')::int
  ), v_room.round_number);

  return jsonb_build_object('ok', true, 'winner', p_winner);
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention / cleanup (PRD §18.E)
--
-- Always bounded. Never a bare DELETE, and never touches an in-progress room.
-- ---------------------------------------------------------------------------

create or replace function public.run_cleanup(p_batch_size integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch   integer := greatest(1, least(coalesce(p_batch_size, 50), 500));
  v_deleted integer := 0;
  v_counters integer := 0;
  v_logs      integer := 0;
begin
  -- 1. Expire stale lobbies that nobody is using.
  update public.rooms
     set expires_at = now(),
         state_version = state_version + 1
   where id in (
     select id from public.rooms
      where status = 'lobby'
        and last_activity_at < now() - interval '2 hours'
      limit v_batch
   );

  -- 2. Expire finished rooms past their 24h retention window.
  update public.rooms
     set expires_at = coalesce(expires_at, now()),
         state_version = state_version + 1
   where id in (
     select id from public.rooms
      where status = 'finished'
        and expires_at is not null
        and expires_at <= now()
      limit v_batch
   );

  -- 3. Delete expired rooms in a bounded batch. Cascades to every game table.
  --    The `status <> 'in_progress'` guard means an active game can never be
  --    collected, even if its expires_at were somehow set.
  with doomed as (
    select id from public.rooms
     where expires_at is not null
       and expires_at <= now()
       and status <> 'in_progress'
     order by expires_at
     limit v_batch
     for update skip locked
  )
  delete from public.rooms r using doomed d where r.id = d.id;
  get diagnostics v_deleted = row_count;

  -- 4. Purge stale rate-limit counters (retain one extra window of slack).
  --    Postgres has no DELETE ... LIMIT, so bound the batch with ctid.
  delete from public.rate_limit_counters
   where ctid in (
     select ctid from public.rate_limit_counters
      where updated_at < now() - interval '2 hours'
      limit v_batch
   );
  get diagnostics v_counters = row_count;

  -- 5. Purge audit logs past their 7-day retention.
  delete from public.game_audit_logs
   where ctid in (
     select ctid from public.game_audit_logs
      where created_at < now() - interval '7 days'
      limit v_batch
   );
  get diagnostics v_logs = row_count;

  return jsonb_build_object(
    'ok', true,
    'roomsDeleted', v_deleted,
    'countersDeleted', v_counters,
    'auditLogsDeleted', v_logs
  );
end;
$$;

-- ===========================================================================
-- Function privileges
--
-- 0002_rls.sql already revokes from every function it can see, but it runs
-- BEFORE this migration creates anything. Postgres grants EXECUTE to PUBLIC by
-- default at CREATE time, so the revocation has to be re-applied here — after
-- the functions exist — or these RPCs would be callable by any holder of the
-- anon key, which would hand the entire game to the client.
--
-- Re-asserted by name rather than by pattern so an unexpected new function is
-- never silently left open.
-- ===========================================================================

do $$
declare
  r          record;
  v_expected text[] := array[
    'create_room', 'join_room', 'leave_room', 'set_role_config', 'start_game',
    'submit_night_action', 'cast_vote', 'claim_phase_transition',
    'commit_phase_transition', 'finish_game', 'consume_rate_limit', 'run_cleanup'
  ];
  v_found    text[] := array[]::text[];
begin
  -- Look signatures up dynamically rather than hardcoding argument lists: a
  -- changed signature is then locked down automatically instead of silently
  -- reverting to PUBLIC execute.
  for r in
    select p.proname, p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = any (v_expected)
  loop
    v_found := array_append(v_found, r.proname);
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;

  -- Fail loudly if any RPC is missing: a missing function means the app and the
  -- database have drifted, which must never pass unnoticed.
  if array_length(v_found, 1) is distinct from array_length(v_expected, 1) then
    raise exception 'RPC lockdown incomplete: expected % functions, found % (missing: %)',
      array_length(v_expected, 1),
      coalesce(array_length(v_found, 1), 0),
      array_to_string(v_expected - v_found, ', ');
  end if;
end $$;
