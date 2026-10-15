-- 0027_tick_room.sql
--
-- Replaces multi-step client/worker phase advancement (claim_phase_transition,
-- pure resolution, commit_phase_transition, release_phase_transition_claim)
-- with a single atomic PostgreSQL function `tick_room(p_room_id uuid)`.
--
-- Every transition executes under `SELECT ... FOR UPDATE` on the room row,
-- eliminating claim tokens, race windows, and orphaned locks.

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
    -- PASS 1: plurality vote among alive players
    with vote_counts as (
      select gv.target_player_id, count(*) as votes
      from public.game_votes gv
      join public.room_players voter on voter.id = gv.voter_player_id
      join public.room_players target on target.id = gv.target_player_id
      where gv.room_id = p_room_id
        and gv.round_number = v_room.round_number
        and voter.is_alive
        and target.is_alive
      group by gv.target_player_id
      order by count(*) desc
      limit 2
    )
    select
      (select target_player_id from vote_counts limit 1),
      (select votes from vote_counts limit 1),
      (select votes from vote_counts offset 1 limit 1)
    into v_vote_target_id, v_vote_count, v_second_vote_count;

    if v_vote_target_id is not null and (v_second_vote_count is null or v_vote_count > v_second_vote_count) then
      update public.room_players
         set is_alive = false, death_cause = 'vote_elimination', died_at = now()
       where id = v_vote_target_id;

      select ps.role_key into v_target_role
      from public.player_secrets ps where ps.player_id = v_vote_target_id limit 1;

      if v_target_role = 'hunter' then
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

revoke all on function public.tick_room(uuid) from public, anon, authenticated;
grant execute on function public.tick_room(uuid) to service_role;
