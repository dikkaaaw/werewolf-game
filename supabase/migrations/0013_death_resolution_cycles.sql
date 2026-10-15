-- Forward-only local foundation for durable death-resolution cycles.
create table if not exists public.death_resolution_cycles (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number integer not null,
  trigger_player_id uuid not null references public.room_players(id) on delete cascade,
  trigger_player_role text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint death_resolution_cycles_status_chk check (status in ('pending','processing','completed','failed'))
);
create unique index if not exists death_resolution_cycles_room_player_uniq on public.death_resolution_cycles(room_id, trigger_player_id);
