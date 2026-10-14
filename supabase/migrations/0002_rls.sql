-- ===========================================================================
-- 0002_rls.sql — Row Level Security
--
-- Order matters: this migration runs BEFORE any client access is opened
-- (docs/IMPLEMENTATION-PLAN.md, ground rule 2).
--
-- Policy summary
-- --------------
--   rooms, room_players, room_role_configs, game_votes, game_events,
--   game_chat_messages          -> readable by room members only
--   player_secrets              -> NO POLICIES. Unreachable from any client.
--   game_actions                -> NO POLICIES. Unreachable from any client.
--   game_action_results         -> NO POLICIES. Unreachable from any client.
--   game_audit_logs             -> NO POLICIES. Internal only.
--   rate_limit_counters         -> NO POLICIES. Backend only, via RPC.
--
-- "No policies" is the strongest guarantee Postgres offers: with RLS enabled
-- and zero policies, every statement is denied for anon/authenticated, while
-- the service role (used only by server code after an ownership check) bypasses
-- RLS entirely. A private table is therefore not merely hidden by a filter —
-- it is unreachable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper functions.
--
-- SECURITY DEFINER because a plain RLS policy on room_players would recurse
-- infinitely (the policy itself queries room_players). `stable` lets the
-- planner evaluate them once per statement.
--
-- `set search_path` is pinned on every function so that a hijacked
-- search_path cannot substitute a malicious object for anything referenced
-- inside the body. This is the single most important line in this migration.
-- ---------------------------------------------------------------------------

create or replace function public.current_player_id(p_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select rp.id
  from public.room_players rp
  where rp.room_id = p_room_id
    and rp.user_id = auth.uid()
$$;

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.user_id = auth.uid()
  )
$$;

create or replace function public.is_room_host(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_user_id = auth.uid()
  )
$$;

create or replace function public.is_alive_player_in_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id
      and rp.user_id = auth.uid()
      and rp.is_alive
  )
$$;

comment on function public.is_room_member(uuid) is
  'SECURITY DEFINER: avoids infinite RLS recursion on room_players. search_path is pinned.';
comment on function public.is_alive_player_in_room(uuid) is
  'SECURITY DEFINER: dead players must not be able to chat or vote.';

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere.
--
-- NOTE: deliberately NOT `force row level security`.
--
-- FORCE also applies policies to the table owner. That breaks the standard
-- Supabase authorisation pattern used above, where a SECURITY DEFINER helper
-- reads `room_players` on behalf of a caller whose own policy also references
-- that helper: with FORCE the owner's read is itself filtered, the lookup
-- returns nothing, and every membership check silently evaluates to false.
--
-- FORCE protects against a table owner querying without RLS. That is not a
-- threat model here: `anon` and `authenticated` never run as the owner, and
-- the backend deliberately uses `service_role`, which has BYPASSRLS. Dropping
-- FORCE costs nothing and keeps the helper functions correct.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'rooms', 'room_players', 'player_secrets', 'room_role_configs',
    'game_actions', 'game_votes', 'game_events', 'game_action_results',
    'game_chat_messages', 'rate_limit_counters', 'game_audit_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ===========================================================================
-- Public read policies
-- ===========================================================================

drop policy if exists rooms_member_read on public.rooms;
create policy rooms_member_read on public.rooms
  for select
  to authenticated
  using (public.is_room_member(id));

drop policy if exists room_players_member_read on public.room_players;
create policy room_players_member_read on public.room_players
  for select
  to authenticated
  using (public.is_room_member(room_id));

-- Role composition is public in the lobby (players must see what they are
-- joining into) and stays visible during the game. It reveals counts of roles,
-- never who holds them.
drop policy if exists room_role_configs_member_read on public.room_role_configs;
create policy room_role_configs_member_read on public.room_role_configs
  for select
  to authenticated
  using (public.is_room_member(room_id));

-- Open voting: every room member may read the votes.
drop policy if exists game_votes_member_read on public.game_votes;
create policy game_votes_member_read on public.game_votes
  for select
  to authenticated
  using (public.is_room_member(room_id));

drop policy if exists game_events_member_read on public.game_events;
create policy game_events_member_read on public.game_events
  for select
  to authenticated
  using (public.is_room_member(room_id));

drop policy if exists game_chat_messages_member_read on public.game_chat_messages;
create policy game_chat_messages_member_read on public.game_chat_messages
  for select
  to authenticated
  using (public.is_room_member(room_id));

-- Chat is the one table clients may write directly. Scoped hard: author must
-- be the caller, and the caller must be alive (dead players cannot discuss).
-- `with check` prevents forging the author column, which would otherwise let a
-- player post as somebody else.
drop policy if exists game_chat_messages_alive_insert on public.game_chat_messages;
create policy game_chat_messages_alive_insert on public.game_chat_messages
  for insert
  to authenticated
  with check (
    public.is_room_member(room_id)
    and public.is_alive_player_in_room(room_id)
    and author_player_id = public.current_player_id(room_id)
  );

-- ===========================================================================
-- Private tables: intentionally NO policies.
--
-- Enabled + forced RLS with zero policies == denied for anon and authenticated.
-- Reachable only by server code using the service role, which must verify
-- ownership before returning anything.
-- ===========================================================================

-- player_secrets          — roles. See migration 0002 header.
-- game_actions            — night actions.
-- game_action_results     — seer readings and other private outcomes.
-- game_audit_logs         — internal.
-- rate_limit_counters     — backend only.
--
-- (no policies defined here by design — do not add them)

-- ===========================================================================
-- Privileges.
--
-- SCOPED TO THE WEREWOLF TABLES ON PURPOSE.
--
-- An earlier draft used `revoke all on all tables in schema public`, which
-- silently strips privileges from every OTHER application sharing this
-- Supabase project. Revokes are global, not scoped to the migration's
-- objects, so that form is a foot-gun in a shared project.
--
-- Everything below therefore names the tables explicitly and fails loudly if
-- one is missing, so a future rename cannot quietly turn this into a no-op
-- that leaves a table half-locked.
-- ===========================================================================

do $$
declare
  t              text;
  v_werewolf     text[] := array[
    'rooms', 'room_players', 'player_secrets', 'room_role_configs',
    'game_actions', 'game_votes', 'game_events', 'game_action_results',
    'game_chat_messages', 'rate_limit_counters', 'game_audit_logs'
  ];
  v_client_read  text[] := array[
    'rooms', 'room_players', 'room_role_configs',
    'game_votes', 'game_events', 'game_chat_messages'
  ];
begin
  -- 1. Lock down every werewolf table for client roles.
  foreach t in array v_werewolf loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'Expected table public.% is missing - run 0001_schema.sql first', t;
    end if;
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;

  -- 2. Grant back only what clients legitimately read.
  foreach t in array v_client_read loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  -- 3. Chat is the single client-writable table; RLS limits it to living
  --    members posting as themselves.
  execute 'grant insert on table public.game_chat_messages to authenticated';

  -- 4. Sequences owned BY OUR TABLES ONLY. Defaults granted by Supabase for
  --    tables we do not own are deliberately left untouched. `relowner` is an
  --    OID, so it is compared against the owner of public.rooms as an OID.
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and c.relowner = (select r.relowner from pg_class r where r.oid = 'public.rooms'::regclass)
  loop
    execute format('revoke all on sequence public.%I from anon, authenticated', t);
    execute format('grant usage, select on sequence public.%I to service_role', t);
  end loop;
end $$;

-- Schema-level USAGE is required for any query to resolve a name. Supabase
-- already grants this; stating it is harmless and makes the dependency explicit.
grant usage on schema public to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Function privileges.
--
-- Helper functions are exposed to `authenticated` because policies call them.
-- Anything that mutates state or reveals secrets is revoked from anon and
-- authenticated so it can only run as service_role (PRD §6 "Additional
-- Security": sensitive EXECUTE must be restricted).
-- ---------------------------------------------------------------------------

revoke all on function public.current_player_id(uuid) from public;
revoke all on function public.is_room_member(uuid) from public;
revoke all on function public.is_room_host(uuid) from public;
revoke all on function public.is_alive_player_in_room(uuid) from public;

grant execute on function public.current_player_id(uuid) to authenticated, service_role;
grant execute on function public.is_room_member(uuid) to authenticated, service_role;
grant execute on function public.is_room_host(uuid) to authenticated, service_role;
grant execute on function public.is_alive_player_in_room(uuid) to authenticated, service_role;

-- Defence in depth: a player must never be able to call the mutation RPCs in
-- 0003 directly with the anon key. They are server-only by default; these
-- explicit revokes make that intent reviewable and survive a bad default.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_room', 'join_room', 'leave_room', 'start_game', 'submit_night_action',
        'cast_vote', 'claim_phase_transition', 'commit_phase_transition',
        'finish_game', 'consume_rate_limit', 'run_cleanup'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;

-- ===========================================================================
-- Realtime publication.
--
-- Only PUBLIC tables. player_secrets, game_actions and game_action_results are
-- deliberately absent — publishing them would make private data broadcast to
-- every subscriber regardless of RLS (PRD §9).
-- ===========================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.rooms;
    exception when duplicate_object then null; end;

    begin
      alter publication supabase_realtime add table public.room_players;
    exception when duplicate_object then null; end;

    begin
      alter publication supabase_realtime add table public.game_votes;
    exception when duplicate_object then null; end;

    begin
      alter publication supabase_realtime add table public.game_events;
    exception when duplicate_object then null; end;
  end if;
end $$;
