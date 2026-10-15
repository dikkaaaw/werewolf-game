-- Synchronize the database role allow-list with src/lib/game/role-registry.ts.
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
    where k not in ('werewolf', 'villager', 'seer', 'guardian_angel', 'lycan', 'hunter', 'doctor')
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

  if v_player_count < 5 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_enough_players',
      'message', format('Need at least 5 players (got %s).', v_player_count)));
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
    where a->>'roleKey' not in ('werewolf', 'villager', 'seer', 'guardian_angel', 'lycan', 'hunter', 'doctor')
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

revoke all on function public.set_role_config(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_role_config(uuid, uuid, jsonb) to service_role;
revoke all on function public.start_game(uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.start_game(uuid, uuid, jsonb, integer) to service_role;
