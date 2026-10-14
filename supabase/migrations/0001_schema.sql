-- ===========================================================================
-- 0001_schema.sql — core game schema
--
-- Apply in order with:  npm run db:migrate   (or `supabase db push`)
--
-- Conventions:
--   * uuid primary keys everywhere (auth.users linkage stays a uuid FK)
--   * timestamptz, never timestamp — deadlines are compared against the server
--     clock and a tz-less column would silently misbehave across regions
--   * explicit ON DELETE behaviour on every FK; rooms cascade to everything
--   * indexes on every column the game loop actually filters by
-- ===========================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- trigram index for room_code lookups

-- ---------------------------------------------------------------------------
-- Enums. These are the database mirror of src/lib/game/types.ts. Changing one
-- in TypeScript requires a new migration here.
-- ---------------------------------------------------------------------------

do $$ begin
  create type player_alignment as enum ('werewolf', 'village', 'neutral');
exception when duplicate_object then null; end $$;

do $$ begin
  create type room_status as enum ('lobby', 'in_progress', 'finished');
exception when duplicate_object then null; end $$;

do $$ begin
  create type game_phase as enum ('lobby', 'night', 'day', 'voting', 'finished');
exception when duplicate_object then null; end $$;

do $$ begin
  create type night_action_type as enum ('eliminate', 'investigate', 'protect');
exception when duplicate_object then null; end $$;

do $$ begin
  create type kill_cause as enum ('night_elimination', 'vote_elimination');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vote_tie_rule as enum ('none', 'random');
exception when duplicate_object then null; end $$;

do $$ begin
  create type game_event_type as enum (
    'player_joined',
    'player_left',
    'game_started',
    'night_started',
    'day_started',
    'voting_started',
    'player_eliminated',
    'night_result_public',
    'vote_result',
    'game_finished'
  );
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- rooms — room metadata, game state, phase deadlines, concurrency control
-- ===========================================================================

create table if not exists rooms (
  id                  uuid primary key default gen_random_uuid(),

  -- Invitation code. High-entropy (31^6), unique, trigram-indexed for lookup.
  room_code           text not null,

  -- The host is an ordinary player: this grants NO visibility into anyone's role.
  host_user_id        uuid not null references auth.users(id) on delete restrict,

  status              room_status   not null default 'lobby',
  phase               game_phase    not null default 'lobby',
  round_number        integer       not null default 0,

  max_players         integer       not null default 20,

  -- Server-authoritative deadline. The browser clock is never consulted.
  phase_ends_at       timestamptz,

  -- Validated game configuration. Locked once status leaves 'lobby'.
  settings            jsonb         not null default '{}'::jsonb,

  -- --- retention & activity (PRD §18.D, §19) ---
  last_activity_at    timestamptz   not null default now(),
  expires_at          timestamptz,

  -- --- concurrency control (see docs/IMPLEMENTATION-PLAN.md) ---
  -- Bumped on every state mutation. A transition claim requires the exact
  -- version the caller read, so two workers cannot both advance the same phase.
  state_version       integer       not null default 0,
  -- Set while a worker is resolving a phase. Non-null blocks other claims
  -- until it goes stale, enabling crash recovery.
  transition_claim    uuid,
  transition_claimed_at timestamptz,

  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  constraint rooms_room_code_format_chk
    check (room_code ~ '^[A-Z0-9]{4,12}$'),
  constraint rooms_max_players_chk
    check (max_players between 2 and 20),
  constraint rooms_round_number_chk
    check (round_number >= 0),
  constraint rooms_state_version_chk
    check (state_version >= 0),
  -- A finished room must not carry a live deadline, and vice versa.
  constraint rooms_phase_deadline_chk
    check (
      (phase in ('lobby', 'finished') and phase_ends_at is null)
      or (phase in ('night', 'day', 'voting') and phase_ends_at is not null)
    ),
  -- Status and phase can never disagree about whether the game is over.
  constraint rooms_status_phase_chk
    check (
      (status = 'lobby'      and phase = 'lobby')
      or (status = 'finished' and phase = 'finished')
      or (status = 'in_progress' and phase in ('night', 'day', 'voting'))
    ),
  -- settings must be a JSON object, never a scalar or array.
  constraint rooms_settings_object_chk
    check (jsonb_typeof(settings) = 'object')
);

-- Uniqueness is the real guarantee against code collisions under concurrency.
create unique index if not exists rooms_room_code_key on rooms (room_code);
create index if not exists rooms_room_code_trgm_idx on rooms using gin (room_code gin_trgm_ops);
create index if not exists rooms_host_user_id_idx on rooms (host_user_id);
create index if not exists rooms_status_idx on rooms (status);
-- Drives the scheduler sweep: "which rooms are past their deadline?"
create index if not exists rooms_phase_ends_at_idx on rooms (phase_ends_at)
  where phase in ('night', 'day', 'voting');
-- Drives the cleanup job.
create index if not exists rooms_expires_at_idx on rooms (expires_at);
create index if not exists rooms_last_activity_at_idx on rooms (last_activity_at)
  where status = 'lobby';

-- ===========================================================================
-- room_players — public roster
-- ===========================================================================

create table if not exists room_players (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references rooms(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,

  display_name   text not null,
  seat_number    integer not null,

  is_alive       boolean     not null default true,
  death_cause    kill_cause,
  died_at        timestamptz,

  joined_at      timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),

  -- One membership per account per room, and one player per seat.
  constraint room_players_room_user_key unique (room_id, user_id),
  constraint room_players_room_seat_key  unique (room_id, seat_number),

  constraint room_players_seat_chk check (seat_number >= 1 and seat_number <= 20),
  constraint room_players_name_len_chk check (char_length(display_name) between 1 and 24),
  -- A player cannot be both dead and un-claimed.
  constraint room_players_death_chk check (
    (is_alive and death_cause is null and died_at is null)
    or (not is_alive and death_cause is not null and died_at is not null)
  )
);

create index if not exists room_players_room_id_idx on room_players (room_id);
create index if not exists room_players_user_id_idx on room_players (user_id);
create index if not exists room_players_room_alive_idx on room_players (room_id) where is_alive;

-- ===========================================================================
-- player_secrets — SECRET role data.
--
-- RLS is enabled in 0002_rls.sql with NO policies at all. There is no client
-- path to this table: the service-role key bypasses RLS and is only reachable
-- from server code that has already verified the caller owns the row.
-- ===========================================================================

create table if not exists player_secrets (
  player_id    uuid primary key references room_players(id) on delete cascade,
  role_key     text not null,
  alignment    player_alignment not null,
  private_state jsonb not null default '{}'::jsonb,

  assigned_at  timestamptz not null default now(),

  constraint player_secrets_private_state_object_chk
    check (jsonb_typeof(private_state) = 'object')
);

create index if not exists player_secrets_role_key_idx on player_secrets (role_key);

-- ===========================================================================
-- room_role_configs — validated role composition, frozen at game start
-- ===========================================================================

create table if not exists room_role_configs (
  room_id     uuid not null references rooms(id) on delete cascade,
  role_key    text not null,
  role_count  integer not null,
  config      jsonb  not null default '{}'::jsonb,

  primary key (room_id, role_key),

  constraint room_role_configs_count_chk check (role_count >= 0),
  constraint room_role_configs_config_object_chk check (jsonb_typeof(config) = 'object')
);

-- ===========================================================================
-- game_actions — private night actions
--
-- Also RLS-locked with no policies (0002_rls.sql).
--
-- The unique key is what makes "one active action per type per round" and
-- "re-submitting replaces" work, and makes replaying a resolution idempotent.
-- ===========================================================================

create table if not exists game_actions (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms(id) on delete cascade,
  round_number      integer not null,
  actor_player_id   uuid not null references room_players(id) on delete cascade,
  action_type       night_action_type not null,
  target_player_id  uuid references room_players(id) on delete cascade,

  payload           jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint game_actions_actor_action_key
    unique (room_id, round_number, actor_player_id, action_type),
  constraint game_actions_round_chk check (round_number >= 1),
  constraint game_actions_no_self_target_chk check (target_player_id is distinct from actor_player_id),
  constraint game_actions_payload_object_chk check (jsonb_typeof(payload) = 'object')
);

create index if not exists game_actions_room_round_idx on game_actions (room_id, round_number);
create index if not exists game_actions_target_idx on game_actions (target_player_id);

-- ===========================================================================
-- game_votes — open voting. Members may READ these; that is what "open" means.
-- ===========================================================================

create table if not exists game_votes (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms(id) on delete cascade,
  round_number      integer not null,
  voter_player_id   uuid not null references room_players(id) on delete cascade,
  target_player_id  uuid not null references room_players(id) on delete cascade,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One active vote per voter per round. Re-submitting UPDATEs this row.
  constraint game_votes_voter_key unique (room_id, round_number, voter_player_id),
  constraint game_votes_round_chk check (round_number >= 1),
  constraint game_votes_no_self_vote_chk check (voter_player_id <> target_player_id)
);

create index if not exists game_votes_room_round_idx on game_votes (room_id, round_number);
create index if not exists game_votes_target_idx on game_votes (target_player_id);

-- ===========================================================================
-- game_events — public, sanitised event log.
--
-- public_payload MUST NOT contain roles, night-action targets, or investigation
-- results until the game rules actually allow announcing them.
-- ===========================================================================

create table if not exists game_events (
  id             bigint generated always as identity primary key,
  room_id        uuid not null references rooms(id) on delete cascade,
  event_type     game_event_type not null,
  public_payload jsonb not null default '{}'::jsonb,
  round_number   integer,
  created_at     timestamptz not null default now(),

  constraint game_events_payload_object_chk check (jsonb_typeof(public_payload) = 'object')
);

-- Pagination key: newest-first is `(room_id, id desc)`; created_at alone is not
-- unique enough to page on.
create index if not exists game_events_room_id_idx on game_events (room_id, id desc);
create index if not exists game_events_room_created_idx on game_events (room_id, created_at desc);
create index if not exists game_events_created_at_idx on game_events (created_at);

-- ===========================================================================
-- game_action_results — PRIVATE ability outcomes (e.g. seer readings)
--
-- Reachable only via an endpoint that verifies the caller owns the action.
-- Never broadcast, never inlined into a public event.
-- ===========================================================================

create table if not exists game_action_results (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms(id) on delete cascade,
  round_number      integer not null,
  action_id         uuid not null references game_actions(id) on delete cascade,
  actor_player_id   uuid not null references room_players(id) on delete cascade,
  result_type       text not null,
  -- Visible to actor_player_id and nobody else.
  result_payload    jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),

  constraint game_action_results_action_key unique (action_id, result_type),
  constraint game_action_results_payload_object_chk check (jsonb_typeof(result_payload) = 'object')
);

create index if not exists game_action_results_actor_idx on game_action_results (actor_player_id);
create index if not exists game_action_results_room_round_idx on game_action_results (room_id, round_number);

-- ===========================================================================
-- game_chat_messages — optional day discussion (not on the critical path)
-- ===========================================================================

create table if not exists game_chat_messages (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references rooms(id) on delete cascade,
  round_number  integer not null,
  author_player_id uuid not null references room_players(id) on delete cascade,
  message       text not null,

  created_at    timestamptz not null default now(),

  constraint game_chat_messages_len_chk check (char_length(message) between 1 and 500),
  -- Belt and braces against script injection through the chat payload.
  constraint game_chat_messages_no_control_chk
    check (message !~ '[[:cntrl:]]')
);

create index if not exists game_chat_messages_room_idx on game_chat_messages (room_id, id desc);

-- ===========================================================================
-- rate_limit_counters — shared across every serverless instance.
--
-- One row per (bucket, key, window). Never one row per request: that is a
-- guaranteed unbounded write amplification (PRD §18.B, §19).
-- ===========================================================================

create table if not exists rate_limit_counters (
  bucket          text not null,
  key             text not null,
  window_started_at timestamptz not null,
  window_seconds  integer not null,
  count           integer not null default 0,
  updated_at      timestamptz not null default now(),

  primary key (bucket, key, window_started_at),

  constraint rate_limit_counters_count_chk check (count >= 0),
  constraint rate_limit_counters_window_chk check (window_seconds > 0)
);

create index if not exists rate_limit_counters_updated_idx on rate_limit_counters (updated_at);

-- ===========================================================================
-- game_audit_logs — internal troubleshooting. No secrets, never client-readable.
-- ===========================================================================

create table if not exists game_audit_logs (
  id           bigint generated always as identity primary key,
  room_id      uuid references rooms(id) on delete cascade,
  actor_user_id uuid,
  action       text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),

  constraint game_audit_logs_detail_object_chk check (jsonb_typeof(detail) = 'object')
);

create index if not exists game_audit_logs_room_idx on game_audit_logs (room_id, created_at desc);
create index if not exists game_audit_logs_created_at_idx on game_audit_logs (created_at);

-- ===========================================================================
-- updated_at maintenance
-- ===========================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  -- Only tables that actually have an `updated_at` column. room_players
  -- deliberately uses `last_seen_at` instead — attaching this trigger to it
  -- would fail at write time with "record new has no field updated_at".
  foreach t in array array['rooms', 'game_actions', 'game_votes', 'rate_limit_counters']
  loop
    execute format('drop trigger if exists trg_%1$s_set_updated_at on public.%1$I', t);
    execute format(
      'create trigger trg_%1$s_set_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
