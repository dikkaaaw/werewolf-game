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
      and status in ('pending', 'processing', 'failed')
  );
$$;
