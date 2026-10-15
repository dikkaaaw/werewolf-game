-- A winning elimination must not finish the room before a Hunter final shot
-- triggered by that elimination has resolved. Authorize and lock first, commit
-- deaths plus mandatory work atomically, then publish `finished` only when no
-- mandatory work remains.
create or replace function public.finish_game(
  p_room_id uuid,
  p_claim uuid,
  p_winner text,
  p_winner_counts jsonb,
  p_eliminations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_elim jsonb;
  v_player uuid;
  v_role text;
  v_cycle uuid;
begin
  if public.has_unresolved_death_resolution(p_room_id) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'death_resolution_pending',
      'message', 'Unresolved death-resolution work blocks finishing the game.'));
  end if;

  -- Authorize and serialize on the room row before writing anything.
  select * into v_room
  from public.rooms
  where id = p_room_id and transition_claim = p_claim
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_lost',
      'message', 'The transition claim was lost or already committed.'));
  end if;

  for v_elim in
    select * from jsonb_array_elements(coalesce(p_eliminations, '[]'::jsonb))
  loop
    v_player := (v_elim->>'playerId')::uuid;
    update public.room_players rp
       set is_alive = false,
           death_cause = (v_elim->>'cause')::kill_cause,
           died_at = now()
     where rp.id = v_player
       and rp.room_id = p_room_id
       and rp.is_alive;

    select ps.role_key into v_role
    from public.player_secrets ps
    where ps.player_id = v_player
    limit 1;

    insert into public.death_resolution_cycles
      (room_id, round_number, trigger_player_id, status)
    values
      (p_room_id, v_room.round_number, v_player,
       case when v_role = 'hunter' then 'pending' else 'completed' end)
    on conflict (room_id, trigger_player_id) do nothing
    returning id into v_cycle;

    if v_role = 'hunter' then
      if v_cycle is null then
        select c.id into v_cycle
        from public.death_resolution_cycles c
        where c.room_id = p_room_id and c.trigger_player_id = v_player;
      end if;
      insert into public.death_resolution_work_items
        (cycle_id, work_key, work_type, payload, status)
      values
        (v_cycle, 'hunter_final_shot_' || v_cycle::text,
         'hunter_final_shot',
         jsonb_build_object('triggerPlayerId', v_player),
         'pending')
      on conflict (cycle_id, work_key) do nothing;
    end if;
  end loop;

  -- A Hunter death inside an otherwise-winning elimination leaves the room in
  -- its current expired phase. Release the claim so the next request retries
  -- after the shot resolves; the pending-work guard prevents any other advance.
  if public.has_unresolved_death_resolution(p_room_id) then
    update public.rooms
       set transition_claim = null,
           transition_claimed_at = null,
           updated_at = now()
     where id = p_room_id and transition_claim = p_claim;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'death_resolution_pending',
      'message', 'Hunter death resolution must finish before the game can end.'));
  end if;

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
   where id = p_room_id and transition_claim = p_claim;

  insert into public.game_events (room_id, event_type, public_payload, round_number)
  values (p_room_id, 'game_finished', jsonb_build_object(
    'winner', p_winner,
    'aliveWerewolves', (p_winner_counts->>'aliveWerewolves')::int,
    'aliveNonWerewolves', (p_winner_counts->>'aliveNonWerewolves')::int
  ), v_room.round_number);

  return jsonb_build_object('ok', true, 'winner', p_winner);
end;
$$;

revoke all on function public.finish_game(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.finish_game(uuid,uuid,text,jsonb,jsonb) to service_role;
