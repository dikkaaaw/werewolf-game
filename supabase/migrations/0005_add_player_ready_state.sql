-- ===========================================================================
-- 0005_add_player_ready_state.sql
--
-- Forward-only migration: Add `is_ready` column to `room_players`
--
-- Defaults to `false`. When a player joins a room in the lobby, they start
-- as not ready until they toggle it.
-- RLS: `room_players` already has `room_players_member_read` policy to authenticated.
-- Write permissions are restricted via service-role / API server gatekeeper.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'room_players'
      and column_name = 'is_ready'
  ) then
    alter table public.room_players
      add column is_ready boolean not null default false;
  end if;
end $$;
