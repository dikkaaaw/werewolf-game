-- Collapse the Hunter death-resolution framework (0013-0021) into a single
-- per-player prompt with a deadline.
--
-- Reference behaviour (Werewolf.cs `HunterFinalShot`): on death a Hunter is
-- asked to shoot and has 30 seconds; no choice means no kill. 0013-0021 modelled
-- this as room-level "cycles" plus "work items" with claim/attempt bookkeeping —
-- three tables and four functions for one 30-second window. All of it is
-- replaced by two columns on the already-existing player row:
--
--   prompt             jsonb        -- e.g. {"type":"hunter_final_shot"}
--   prompt_deadline_at timestamptz
--
-- A room is "blocked" while any player still carries a prompt. A prompt is
-- answered by the Hunter it belongs to, or cleared by expiry. This is the same
-- shape as the reference's per-player `CurrentQuestion`.
--
-- Forward migration: 0013-0021 stay in history so an already-linked remote
-- project converges with `supabase db push`.

alter table public.room_players
  add column if not exists prompt jsonb,
  add column if not exists prompt_deadline_at timestamptz;

-- True while any player in the room owes a prompt response.
create or replace function public.room_has_unresolved_prompt(p_room_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room_id and prompt is not null
  );
$$;

revoke all on function public.room_has_unresolved_prompt(uuid) from public, anon, authenticated;
grant execute on function public.room_has_unresolved_prompt(uuid) to service_role;

-- claim_phase_transition: block while a prompt is unanswered.
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
     and not public.room_has_unresolved_prompt(p_room_id)
     and (
       r.transition_claim is null
       or r.transition_claimed_at is null
       or r.transition_claimed_at < now() - make_interval(secs => p_claim_timeout_seconds)
     )
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_failed',
      'message', 'Phase transition was not claimed (already processed, not expired, contended, or blocked by an unanswered prompt).'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'claim', v_room.transition_claim,
    'room', to_jsonb(v_room) - 'transition_claim' - 'transition_claimed_at'
  );
end;
$$;

-- commit_phase_transition: apply eliminations, raise a prompt for each dead
-- Hunter, publish events, advance the phase.
create or replace function public.commit_phase_transition(
  p_room_id uuid,
  p_claim uuid,
  p_next_phase text,
  p_round_number integer,
  p_phase_seconds integer,
  p_eliminations jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_elim jsonb;
  v_evt jsonb;
  v_player uuid;
  v_role text;
begin
  if public.room_has_unresolved_prompt(p_room_id) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'death_resolution_pending',
      'message', 'An unanswered prompt blocks this transition.'));
  end if;

  update public.rooms
     set phase = p_next_phase::game_phase,
         round_number = p_round_number,
         phase_ends_at = case when p_next_phase in ('night','day','voting') then now() + make_interval(secs => greatest(p_phase_seconds,15)) else null end,
         status = case when p_next_phase = 'finished' then 'finished' else status end,
         transition_claim = null,
         transition_claimed_at = null,
         last_activity_at = now(),
         updated_at = now()
   where id = p_room_id and transition_claim = p_claim
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_lost', 'message', 'The transition claim was lost or already committed.'));
  end if;

  for v_elim in select * from jsonb_array_elements(coalesce(p_eliminations, '[]'::jsonb))
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

    if v_role = 'hunter' then
      update public.room_players
         set prompt = jsonb_build_object('type', 'hunter_final_shot'),
             prompt_deadline_at = now() + interval '30 seconds'
       where id = v_player and room_id = p_room_id;
    end if;
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

-- finish_game: apply the winning eliminations, raise prompts, and defer the
-- finish while a prompt is unanswered (the shot may change the winner).
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
begin
  if public.room_has_unresolved_prompt(p_room_id) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'death_resolution_pending',
      'message', 'An unanswered prompt blocks finishing the game.'));
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

    if v_role = 'hunter' then
      update public.room_players
         set prompt = jsonb_build_object('type', 'hunter_final_shot'),
             prompt_deadline_at = now() + interval '30 seconds'
       where id = v_player and room_id = p_room_id;
    end if;
  end loop;

  -- A Hunter death inside an otherwise-winning elimination keeps the room in
  -- its current expired phase. Release the claim so the next request retries
  -- after the shot resolves; the prompt guard prevents any other advance.
  if public.room_has_unresolved_prompt(p_room_id) then
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

-- apply_hunter_final_shot: answer the caller's prompt. Exactly one shot; a
-- follow-up prompt is raised if the target was themselves a Hunter.
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
  v_room public.rooms%rowtype;
  v_shooter public.room_players%rowtype;
  v_role text;
  v_killed integer;
  v_alive_total integer;
  v_alive_werewolves integer;
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

  select * into v_shooter
  from public.room_players
  where room_id = p_room_id
    and user_id = p_user_id
    and prompt is not null
    and prompt->>'type' = 'hunter_final_shot'
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'hunter_action_unavailable',
      'message', 'No pending Hunter action exists for this room.'));
  end if;

  if v_shooter.prompt_deadline_at is not null and now() > v_shooter.prompt_deadline_at then
    update public.room_players
       set prompt = null, prompt_deadline_at = null
     where id = v_shooter.id;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'hunter_action_expired',
      'message', 'The Hunter action expired before a valid target was selected.'));
  end if;

  if p_target_player_id = v_shooter.id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_target',
      'message', 'Invalid Hunter target.'));
  end if;

  update public.room_players
     set is_alive = false, death_cause = 'hunter_shot', died_at = now()
   where id = p_target_player_id and room_id = p_room_id and is_alive;
  get diagnostics v_killed = row_count;
  if v_killed <> 1 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_target',
      'message', 'Invalid Hunter target.'));
  end if;

  update public.room_players
     set prompt = null, prompt_deadline_at = null
   where id = v_shooter.id;

  select ps.role_key into v_role
  from public.player_secrets ps
  where ps.player_id = p_target_player_id
  limit 1;

  if v_role = 'hunter' then
    update public.room_players
       set prompt = jsonb_build_object('type', 'hunter_final_shot'),
           prompt_deadline_at = now() + interval '30 seconds'
     where id = p_target_player_id;
  end if;

  if not public.room_has_unresolved_prompt(p_room_id) then
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

-- expire_pending_hunter_final_shots: clear overdue prompts. No invented target.
create or replace function public.expire_pending_hunter_final_shots(p_room_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired integer := 0;
begin
  update public.room_players
     set prompt = null, prompt_deadline_at = null
   where prompt is not null
     and prompt->>'type' = 'hunter_final_shot'
     and prompt_deadline_at is not null
     and now() > prompt_deadline_at
     and (p_room_id is null or room_id = p_room_id);
  get diagnostics v_expired = row_count;
  return jsonb_build_object('ok', true, 'expired', v_expired);
end;
$$;

revoke all on function public.claim_phase_transition(uuid,integer,text,integer) from public, anon, authenticated;
grant execute on function public.claim_phase_transition(uuid,integer,text,integer) to service_role;
revoke all on function public.commit_phase_transition(uuid,uuid,text,integer,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.commit_phase_transition(uuid,uuid,text,integer,integer,jsonb,jsonb) to service_role;
revoke all on function public.finish_game(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.finish_game(uuid,uuid,text,jsonb,jsonb) to service_role;
revoke all on function public.apply_hunter_final_shot(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.apply_hunter_final_shot(uuid,uuid,uuid) to service_role;
revoke all on function public.expire_pending_hunter_final_shots(uuid) from public, anon, authenticated;
grant execute on function public.expire_pending_hunter_final_shots(uuid) to service_role;

-- Retire the cycle/work-item framework.
drop function if exists public.has_unresolved_death_resolution(uuid);
drop function if exists public.death_resolution_has_unresolved_work(uuid);
drop table if exists public.death_resolution_work_items cascade;
drop table if exists public.death_resolution_cycles cascade;
