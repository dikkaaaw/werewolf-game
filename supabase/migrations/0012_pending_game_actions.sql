create table public.game_pending_actions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.room_players(id) on delete cascade,
  round_number integer not null,
  action_kind text not null,
  payload jsonb not null default '{}'::jsonb,
  target_player_id uuid null references public.room_players(id) on delete set null,
  resolution_token uuid not null,
  status text not null check (status in ('pending','resolved','expired')),
  deadline_at timestamptz not null,
  result_payload jsonb null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null
);

create index game_pending_actions_room_status_idx
  on public.game_pending_actions (room_id, status, deadline_at);

create unique index game_pending_actions_unique_kind
  on public.game_pending_actions (room_id, round_number, player_id, action_kind);

create or replace function public.create_pending_action (
  p_room_id uuid,
  p_round_number integer,
  p_player_id uuid,
  p_action_kind text,
  p_deadline_at timestamptz,
  p_target_player_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_id uuid;
begin
  -- Serialize against concurrent room lifecycle changes. This keeps a pending
  -- action from being created for a room that is finishing or has finished.
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'room_not_found'; end if;
  if v_room.status <> 'in_progress' then
    raise exception 'room_not_in_progress';
  end if;
  select * into v_player from public.room_players
  where id = p_player_id and room_id = p_room_id for update;
  if not found then raise exception 'player_not_in_room'; end if;
  if p_action_kind is null or trim(p_action_kind)='' then raise exception 'invalid_action_kind'; end if;
  if p_deadline_at <= now() then raise exception 'invalid_deadline'; end if;
  insert into public.game_pending_actions
    (room_id, player_id, round_number, action_kind, payload, target_player_id, resolution_token, status, deadline_at)
  values
    (p_room_id, p_player_id, p_round_number, p_action_kind, coalesce(p_payload,'{}'::jsonb), p_target_player_id, gen_random_uuid(), 'pending', p_deadline_at)
  on conflict (room_id, round_number, player_id, action_kind) do nothing
  returning id into v_id;
  if v_id is null then
    return (select id from public.game_pending_actions where room_id=p_room_id and round_number=p_round_number and player_id=p_player_id and action_kind=p_action_kind);
  end if;
  return v_id;
end;
$$;

create or replace function public.resolve_pending_action (
  p_action_id uuid,
  p_token uuid,
  p_result_payload jsonb default null
)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v public.game_pending_actions%rowtype;
begin
  select * into v from public.game_pending_actions where id=p_action_id for update;
  if not found then raise exception 'pending_action_not_found'; end if;
  if v.status='resolved' and v.resolution_token=p_token then return; end if;
  if v.status in ('resolved','expired') then raise exception 'pending_action_already_finalized'; end if;
  if v.resolution_token <> p_token then raise exception 'invalid_resolution_token'; end if;
  if now() >= v.deadline_at then raise exception 'pending_action_expired'; end if;
  update public.game_pending_actions set status='resolved', resolved_at=now(), result_payload=coalesce(p_result_payload,'{}'::jsonb) where id=p_action_id;
end;
$$;

create or replace function public.finalize_expired_pending_actions (p_batch_size integer default 100)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  update public.game_pending_actions
    set status='expired', resolved_at=now()
  where id in (
    select id from public.game_pending_actions
    where status='pending' and now() >= deadline_at
    order by deadline_at
    limit p_batch_size
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on table public.game_pending_actions from public, anon, authenticated;
grant all on table public.game_pending_actions to service_role;
revoke all on function public.create_pending_action(uuid,integer,uuid,text,timestamptz,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.create_pending_action(uuid,integer,uuid,text,timestamptz,uuid,jsonb) to service_role;
revoke all on function public.resolve_pending_action(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.resolve_pending_action(uuid,uuid,jsonb) to service_role;
revoke all on function public.finalize_expired_pending_actions(integer) from public, anon, authenticated;
grant execute on function public.finalize_expired_pending_actions(integer) to service_role;
