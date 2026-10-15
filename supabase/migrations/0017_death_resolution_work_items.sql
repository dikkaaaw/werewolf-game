create table if not exists public.death_resolution_work_items (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.death_resolution_cycles(id) on delete cascade,
  work_key text not null,
  work_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint death_resolution_work_status_chk check (status in ('pending','processing','completed','failed')),
  constraint death_resolution_work_unique_key unique (cycle_id, work_key)
);
create index if not exists death_resolution_work_cycle_idx on public.death_resolution_work_items(cycle_id);
create index if not exists death_resolution_work_status_idx on public.death_resolution_work_items(status);

create or replace function public.death_resolution_has_unresolved_work(p_room_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.death_resolution_work_items wi
    join public.death_resolution_cycles c on c.id = wi.cycle_id
    where c.room_id = p_room_id
      and wi.status in ('pending','processing','failed')
  );
$$;

create or replace function public.has_unresolved_death_resolution(p_room_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.death_resolution_cycles c
    where c.room_id = p_room_id
      and c.status in ('pending','processing','failed')
  ) or public.death_resolution_has_unresolved_work(p_room_id);
$$;
