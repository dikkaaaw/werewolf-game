-- Atomic Hunter final-shot handling.
create or replace function public.apply_hunter_final_shot(
  p_room_id uuid,
  p_user_id uuid,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle_id uuid;
  v_work_id uuid;
  v_created_at timestamptz;
  v_trigger_player_id uuid;
  v_claimed uuid;
  v_killed integer;
  v_role text;
  v_cycle uuid;
  v_target_alive boolean;
  v_room public.rooms%rowtype;
  v_alive_werewolves integer;
  v_alive_total integer;
  v_winner text;
begin
  select * into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if not found or v_room.status <> 'in_progress' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'hunter_action_unavailable',
      'message', 'No pending Hunter action exists for this room.'));
  end if;

  select c.id, w.id, c.created_at, c.trigger_player_id
    into v_cycle_id, v_work_id, v_created_at, v_trigger_player_id
  from public.death_resolution_cycles c
  join public.death_resolution_work_items w on w.cycle_id = c.id
  join public.room_players rp on rp.id = c.trigger_player_id
  where c.room_id = p_room_id
    and rp.user_id = p_user_id
    and c.status in ('pending', 'processing')
    and w.work_type = 'hunter_final_shot'
    and w.status in ('pending', 'processing')
  limit 1
  for update of c, w;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'hunter_action_unavailable',
      'message', 'No pending Hunter action exists for this room.'));
  end if;

  if now() > (v_created_at + interval '30 seconds') then
    update public.death_resolution_work_items
      set status='completed', completed_at=now(),
          payload=payload || jsonb_build_object('outcome', 'expired')
    where id=v_work_id;
    update public.death_resolution_cycles set status='completed', completed_at=now() where id=v_cycle_id;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'hunter_action_expired',
      'message', 'The Hunter action expired before a valid target was selected.'));
  end if;

  if p_target_player_id = v_trigger_player_id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_target',
      'message', 'Invalid Hunter target.'));
  end if;

  select is_alive into v_target_alive
    from public.room_players
    where id = p_target_player_id and room_id = p_room_id;
  if not coalesce(v_target_alive, false) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_target',
      'message', 'Invalid Hunter target.'));
  end if;

  -- Atomically claim and complete. The status guard provides mutual exclusion.
  update public.death_resolution_work_items
    set status='processing', attempts=attempts+1
  where id = v_work_id and status in ('pending','processing')
  returning id into v_claimed;

  update public.room_players
    set is_alive=false, death_cause='hunter_shot', died_at=now()
  where id=p_target_player_id and room_id=p_room_id and is_alive;
  get diagnostics v_killed = row_count;
  if v_killed <> 1 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_target',
      'message', 'Invalid Hunter target.'));
  end if;

  select ps.role_key into v_role
    from public.player_secrets ps
    where ps.player_id = p_target_player_id
    limit 1;

  if v_role = 'hunter' then
    insert into public.death_resolution_cycles (room_id, round_number, trigger_player_id, status)
      values (p_room_id, (select g.round_number from public.rooms g where g.id=p_room_id), p_target_player_id, 'pending')
      on conflict (room_id, trigger_player_id) do nothing
      returning id into v_cycle;
    if v_cycle is null then
      select c.id into v_cycle
        from public.death_resolution_cycles c
        where c.room_id = p_room_id and c.trigger_player_id = p_target_player_id;
    end if;
    insert into public.death_resolution_work_items (cycle_id, work_key, work_type, payload, status)
      values (v_cycle, 'hunter_final_shot_' || v_cycle::text, 'hunter_final_shot',
              jsonb_build_object('triggerPlayerId', p_target_player_id), 'pending')
    on conflict (cycle_id, work_key) do nothing;
  end if;

  update public.death_resolution_work_items
    set status='completed', completed_at=now(),
        payload = payload || jsonb_build_object('targetPlayerId', p_target_player_id)
  where id=v_work_id;
  update public.death_resolution_cycles
    set status='completed', completed_at=now()
  where id=v_cycle_id;

  if not public.has_unresolved_death_resolution(p_room_id) then
    select count(*) into v_alive_total
    from public.room_players
    where room_id = p_room_id and is_alive;

    select count(*) into v_alive_werewolves
    from public.room_players rp
    join public.player_secrets ps on ps.player_id = rp.id
    where rp.room_id = p_room_id
      and rp.is_alive
      and ps.alignment = 'werewolf';

    if v_alive_werewolves = 0 then
      v_winner := 'village';
    elsif v_alive_werewolves >= (v_alive_total - v_alive_werewolves) then
      v_winner := 'werewolf';
    end if;

    if v_winner is not null then
      update public.rooms
         set status = 'finished', phase = 'finished', phase_ends_at = null,
             transition_claim = null, transition_claimed_at = null,
             settings = settings || jsonb_build_object('winner', v_winner),
             expires_at = now() + interval '24 hours',
             last_activity_at = now(), updated_at = now()
       where id = p_room_id and status = 'in_progress';

      insert into public.game_events (room_id, event_type, public_payload, round_number)
      values (p_room_id, 'game_finished', jsonb_build_object(
        'winner', v_winner,
        'aliveWerewolves', v_alive_werewolves,
        'aliveNonWerewolves', v_alive_total - v_alive_werewolves
      ), v_room.round_number);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'targetPlayerId', p_target_player_id,
    'gameFinished', v_winner is not null,
    'winner', v_winner);
end;
$$;

revoke all on function public.apply_hunter_final_shot(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_hunter_final_shot(uuid, uuid, uuid) to service_role;
