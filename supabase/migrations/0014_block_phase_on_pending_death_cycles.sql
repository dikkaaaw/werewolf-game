create or replace function public.has_unresolved_death_resolution(p_room_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.death_resolution_cycles
    where room_id = p_room_id
      and status in ('pending', 'processing')
  );
$$;

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
     and not public.has_unresolved_death_resolution(p_room_id)
     and (
       r.transition_claim is null
       or r.transition_claimed_at is null
       or r.transition_claimed_at < now() - make_interval(secs => p_claim_timeout_seconds)
     )
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_failed',
      'message', 'Phase transition was not claimed (already processed, not expired, contended, or blocked by unresolved death-resolution work).'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'claim', v_room.transition_claim,
    'room', to_jsonb(v_room) - 'transition_claim' - 'transition_claimed_at'
  );
end;
$$;
