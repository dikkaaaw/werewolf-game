-- 0029_add_mayor_role.sql
--
-- Supports the Mayor role:
-- 1. Adds 'mayor' to role allowlists in set_role_config and start_game.
-- 2. In tick_room voting resolution, Mayor's vote counts as 2 votes.

create or replace function public.set_role_config(
  p_room_id  uuid,
  p_user_id  uuid,
  p_entries  jsonb
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

  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'game_already_started', 'message', 'The role configuration is locked once the game starts.'));
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_config', 'message', 'Expected an array of role entries.'));
  end if;

  select count(*) into v_player_count from public.room_players rp where rp.room_id = p_room_id;

  select coalesce(array_agg(e->>'roleKey'), '{}')
    into v_keys
  from jsonb_array_elements(p_entries) e;

  if exists (
    select 1 from unnest(v_keys) k
    where k not in ('werewolf', 'villager', 'seer', 'guardian_angel', 'lycan', 'hunter', 'doctor', 'tanner', 'mayor')
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
              case when v_entry->>'roleKey' = 'doctor' then 'guardian_angel' else v_entry->>'roleKey' end,
              (v_entry->>'roleCount')::integer,
              coalesce(v_entry->'config', '{}'::jsonb));
    end if;
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.start_game(
  p_room_id        uuid,
  p_user_id        uuid,
  p_assignments    jsonb,
  p_night_seconds  integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room         public.rooms%rowtype;
  v_player_count integer;
  v_role_total   integer;
  v_assigned     integer;
  v_assignment   jsonb;
  v_config       jsonb;
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
    where a->>'roleKey' not in ('werewolf', 'villager', 'seer', 'guardian_angel', 'lycan', 'hunter', 'doctor', 'tanner', 'mayor')
  ) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'unsupported_role', 'message', 'Assignment contains an unsupported role.'));
  end if;

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
  values (p_room_id, 'game_started', jsonb_build_object(
    'playerCount', v_player_count,
    'roundNumber', 1
  ), 1);

  insert into public.game_events (room_id, event_type, public_payload, round_number)
  values (p_room_id, 'night_started', jsonb_build_object('roundNumber', 1), 1);

  return jsonb_build_object('ok', true, 'roundNumber', 1);
end;
$$;

create or replace function public.tick_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_prompt_active boolean;
  v_alive_werewolves integer;
  v_alive_total integer;
  v_winner text;
  v_next_round integer;
  v_phase_seconds integer;
  
  -- Night resolution variables
  v_wolf_target_id uuid;
  v_protected_ids uuid[];
  v_action record;
  v_target_role text;
  v_target_alignment text;
  
  -- Vote resolution variables
  v_vote_target_id uuid;
  v_vote_count integer;
  v_second_vote_count integer;
begin
  -- 1. Lock room
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status <> 'in_progress' then
    return jsonb_build_object('ok', true, 'advanced', false, 'reason', 'not_in_progress');
  end if;

  -- 2. Expire any overdue prompts first
  update public.room_players
     set prompt = null, prompt_deadline_at = null
   where room_id = p_room_id
     and prompt is not null
     and prompt_deadline_at is not null
     and now() > prompt_deadline_at;

  -- 3. Check if any unanswered prompt remains
  select exists(
    select 1 from public.room_players where room_id = p_room_id and prompt is not null
  ) into v_prompt_active;

  if v_prompt_active then
    return jsonb_build_object('ok', true, 'advanced', false, 'reason', 'prompt_pending');
  end if;

  -- 4. Check if phase has expired
  if v_room.phase_ends_at is null or now() < v_room.phase_ends_at then
    return jsonb_build_object('ok', true, 'advanced', false, 'reason', 'not_expired');
  end if;

  -- 5. Advance based on current phase
  if v_room.phase = 'night' then
    -- PASS 1: collect protections
    select coalesce(array_agg(ga.target_player_id), array[]::uuid[]) into v_protected_ids
    from public.game_actions ga
    join public.room_players rp on rp.id = ga.actor_player_id
    where ga.room_id = p_room_id
      and ga.round_number = v_room.round_number
      and ga.action_type = 'protect'
      and rp.is_alive;

    -- PASS 2: plurality wolf elimination with tie-break lowest seat_number
    select ga.target_player_id into v_wolf_target_id
    from public.game_actions ga
    join public.room_players target_rp on target_rp.id = ga.target_player_id
    where ga.room_id = p_room_id
      and ga.round_number = v_room.round_number
      and ga.action_type = 'eliminate'
      and target_rp.is_alive
    group by ga.target_player_id, target_rp.seat_number
    order by count(*) desc, target_rp.seat_number asc
    limit 1;

    -- If wolf target chosen and not protected -> eliminate
    if v_wolf_target_id is not null and not (v_wolf_target_id = any(v_protected_ids)) then
      update public.room_players
         set is_alive = false, death_cause = 'night_elimination', died_at = now()
       where id = v_wolf_target_id;

      select ps.role_key into v_target_role
      from public.player_secrets ps where ps.player_id = v_wolf_target_id limit 1;

      if v_target_role = 'hunter' then
        update public.room_players
           set prompt = jsonb_build_object('type', 'hunter_final_shot'),
               prompt_deadline_at = now() + interval '30 seconds'
         where id = v_wolf_target_id;
      end if;
    end if;

    -- PASS 3: Seer investigations
    for v_action in
      select ga.id as action_id, ga.actor_player_id, ga.target_player_id,
             ps.role_key as target_role, ps.alignment as target_alignment
      from public.game_actions ga
      join public.room_players rp on rp.id = ga.actor_player_id
      join public.player_secrets ps on ps.player_id = ga.target_player_id
      where ga.room_id = p_room_id
        and ga.round_number = v_room.round_number
        and ga.action_type = 'investigate'
        and rp.is_alive
    loop
      v_target_alignment := case when v_action.target_role = 'lycan' then 'village' else v_action.target_alignment end;
      insert into public.game_action_results (
        room_id, round_number, action_id, actor_player_id, result_type, result_payload
      ) values (
        p_room_id, v_room.round_number, v_action.action_id, v_action.actor_player_id,
        'investigate',
        jsonb_build_object('targetPlayerId', v_action.target_player_id, 'alignment', v_target_alignment)
      )
      on conflict (action_id, result_type) do nothing;
    end loop;

    -- CHECK WIN
    select count(*) into v_alive_total from public.room_players where room_id = p_room_id and is_alive;
    select count(*) into v_alive_werewolves
    from public.room_players rp
    join public.player_secrets ps on ps.player_id = rp.id
    where rp.room_id = p_room_id and rp.is_alive and ps.alignment = 'werewolf';

    if v_alive_werewolves = 0 then
      v_winner := 'village';
    elsif v_alive_werewolves >= (v_alive_total - v_alive_werewolves) then
      v_winner := 'werewolf';
    end if;

    -- Check if hunter prompt active
    select exists(
      select 1 from public.room_players where room_id = p_room_id and prompt is not null
    ) into v_prompt_active;

    if v_winner is not null and not v_prompt_active then
      update public.rooms
         set status = 'finished', phase = 'finished', phase_ends_at = null,
             transition_claim = null, transition_claimed_at = null,
             settings = settings || jsonb_build_object('winner', v_winner),
             expires_at = now() + interval '24 hours',
             last_activity_at = now(), updated_at = now()
       where id = p_room_id;

      insert into public.game_events (room_id, event_type, public_payload, round_number)
      values (p_room_id, 'game_finished', jsonb_build_object(
        'winner', v_winner,
        'aliveWerewolves', v_alive_werewolves,
        'aliveNonWerewolves', v_alive_total - v_alive_werewolves
      ), v_room.round_number);

      return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'finished', 'winner', v_winner);
    end if;

    -- Advance to Day
    v_phase_seconds := coalesce((v_room.settings->'phaseSeconds'->>'day')::integer, 10);
    update public.rooms
       set phase = 'day',
           phase_ends_at = now() + make_interval(secs => greatest(v_phase_seconds, 10)),
           state_version = state_version + 1,
           transition_claim = null, transition_claimed_at = null,
           last_activity_at = now(), updated_at = now()
     where id = p_room_id;

    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id, 'day_started', jsonb_build_object('roundNumber', v_room.round_number), v_room.round_number);

    if v_wolf_target_id is not null and not (v_wolf_target_id = any(v_protected_ids)) then
      insert into public.game_events (room_id, event_type, public_payload, round_number)
      select p_room_id, 'player_eliminated'::game_event_type,
             jsonb_build_object('playerId', rp.id, 'seatNumber', rp.seat_number, 'displayName', rp.display_name),
             v_room.round_number
      from public.room_players rp where rp.id = v_wolf_target_id;
    end if;

    return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'day', 'roundNumber', v_room.round_number);

  elsif v_room.phase = 'day' then
    -- Advance day -> voting
    v_phase_seconds := coalesce((v_room.settings->'phaseSeconds'->>'voting')::integer, 10);
    update public.rooms
       set phase = 'voting',
           phase_ends_at = now() + make_interval(secs => greatest(v_phase_seconds, 10)),
           state_version = state_version + 1,
           transition_claim = null, transition_claimed_at = null,
           last_activity_at = now(), updated_at = now()
     where id = p_room_id;

    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id, 'voting_started', jsonb_build_object('roundNumber', v_room.round_number), v_room.round_number);

    return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'voting', 'roundNumber', v_room.round_number);

  elsif v_room.phase = 'voting' then
    -- PASS 1: plurality vote among alive players, Mayor's vote weights 2
    with vote_weights as (
      select gv.target_player_id,
             sum(case when ps.role_key = 'mayor' then 2 else 1 end) as votes
      from public.game_votes gv
      join public.room_players voter on voter.id = gv.voter_player_id
      join public.room_players target on target.id = gv.target_player_id
      left join public.player_secrets ps on ps.player_id = voter.id
      where gv.room_id = p_room_id
        and gv.round_number = v_room.round_number
        and voter.is_alive
        and target.is_alive
      group by gv.target_player_id
      order by sum(case when ps.role_key = 'mayor' then 2 else 1 end) desc
      limit 2
    )
    select
      (select target_player_id from vote_weights limit 1),
      (select votes from vote_weights limit 1),
      (select votes from vote_weights offset 1 limit 1)
    into v_vote_target_id, v_vote_count, v_second_vote_count;

    if v_vote_target_id is not null and (v_second_vote_count is null or v_vote_count > v_second_vote_count) then
      update public.room_players
         set is_alive = false, death_cause = 'vote_elimination', died_at = now()
       where id = v_vote_target_id;

      select ps.role_key into v_target_role
      from public.player_secrets ps where ps.player_id = v_vote_target_id limit 1;

      -- TANNER VICTORY: If the Tanner is lynched, Tanner wins immediately!
      if v_target_role = 'tanner' then
        v_winner := 'tanner';
      elsif v_target_role = 'hunter' then
        update public.room_players
           set prompt = jsonb_build_object('type', 'hunter_final_shot'),
               prompt_deadline_at = now() + interval '30 seconds'
         where id = v_vote_target_id;
      end if;

      insert into public.game_events (room_id, event_type, public_payload, round_number)
      select p_room_id, 'player_eliminated'::game_event_type,
             jsonb_build_object('playerId', rp.id, 'seatNumber', rp.seat_number, 'displayName', rp.display_name),
             v_room.round_number
      from public.room_players rp where rp.id = v_vote_target_id;
    end if;

    -- If Tanner won by being lynched, finish the game immediately!
    if v_winner = 'tanner' then
      update public.rooms
         set status = 'finished', phase = 'finished', phase_ends_at = null,
             transition_claim = null, transition_claimed_at = null,
             settings = settings || jsonb_build_object('winner', 'tanner'),
             expires_at = now() + interval '24 hours',
             last_activity_at = now(), updated_at = now()
       where id = p_room_id;

      insert into public.game_events (room_id, event_type, public_payload, round_number)
      values (p_room_id, 'game_finished', jsonb_build_object(
        'winner', 'tanner'
      ), v_room.round_number);

      return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'finished', 'winner', 'tanner');
    end if;

    -- Check win condition
    select count(*) into v_alive_total from public.room_players where room_id = p_room_id and is_alive;
    select count(*) into v_alive_werewolves
    from public.room_players rp
    join public.player_secrets ps on ps.player_id = rp.id
    where rp.room_id = p_room_id and rp.is_alive and ps.alignment = 'werewolf';

    if v_alive_werewolves = 0 then
      v_winner := 'village';
    elsif v_alive_werewolves >= (v_alive_total - v_alive_werewolves) then
      v_winner := 'werewolf';
    end if;

    select exists(
      select 1 from public.room_players where room_id = p_room_id and prompt is not null
    ) into v_prompt_active;

    if v_winner is not null and not v_prompt_active then
      update public.rooms
         set status = 'finished', phase = 'finished', phase_ends_at = null,
             transition_claim = null, transition_claimed_at = null,
             settings = settings || jsonb_build_object('winner', v_winner),
             expires_at = now() + interval '24 hours',
             last_activity_at = now(), updated_at = now()
       where id = p_room_id;

      insert into public.game_events (room_id, event_type, public_payload, round_number)
      values (p_room_id, 'game_finished', jsonb_build_object(
        'winner', v_winner,
        'aliveWerewolves', v_alive_werewolves,
        'aliveNonWerewolves', v_alive_total - v_alive_werewolves
      ), v_room.round_number);

      return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'finished', 'winner', v_winner);
    end if;

    -- Advance to Night (round + 1)
    v_next_round := v_room.round_number + 1;
    v_phase_seconds := coalesce((v_room.settings->'phaseSeconds'->>'night')::integer, 10);
    update public.rooms
       set phase = 'night',
           round_number = v_next_round,
           phase_ends_at = now() + make_interval(secs => greatest(v_phase_seconds, 10)),
           state_version = state_version + 1,
           transition_claim = null, transition_claimed_at = null,
           last_activity_at = now(), updated_at = now()
     where id = p_room_id;

    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id, 'night_started', jsonb_build_object('roundNumber', v_next_round), v_next_round);

    return jsonb_build_object('ok', true, 'advanced', true, 'nextPhase', 'night', 'roundNumber', v_next_round);
  end if;

  return jsonb_build_object('ok', true, 'advanced', false);
end;
$$;

revoke all on function public.set_role_config(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.set_role_config(uuid,uuid,jsonb) to service_role;
revoke all on function public.start_game(uuid,uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.start_game(uuid,uuid,jsonb,integer) to service_role;
revoke all on function public.tick_room(uuid) from public, anon, authenticated;
grant execute on function public.tick_room(uuid) to service_role;
