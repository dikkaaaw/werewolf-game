create or replace function public.expire_pending_hunter_final_shots(p_room_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired int := 0;
  v_work record;
begin
  for v_work in
    select w.id, c.id as cycle_id
    from public.death_resolution_work_items w
    join public.death_resolution_cycles c on c.id = w.cycle_id
    where w.work_type = 'hunter_final_shot'
      and w.status in ('pending','processing')
      and c.status in ('pending','processing')
      and (p_room_id is null or c.room_id = p_room_id)
      and now() > (c.created_at + interval '30 seconds')
  loop
    update public.death_resolution_work_items
      set status='failed', completed_at=now()
    where id = v_work.id;
    update public.death_resolution_cycles
      set status='completed', completed_at=now()
    where id = v_work.cycle_id;
    v_expired := v_expired + 1;
  end loop;
  return jsonb_build_object('ok', true, 'expired', v_expired);
end;
$$;

revoke all on function public.expire_pending_hunter_final_shots(uuid) from public, anon, authenticated;
grant execute on function public.expire_pending_hunter_final_shots(uuid) to service_role;
