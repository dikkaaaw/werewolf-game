-- 0032_fix_room_players_update.sql
--
-- Memperbaiki celah update pada room_players:
-- 1. Batasi hak akses UPDATE dari role authenticated hanya ke kolom is_ready dan last_seen_at.
-- 2. Tambahkan trigger guard untuk memastikan kolom kritis (is_alive, seat_number, room_id, dll)
--    tidak bisa dimanipulasi langsung oleh user client-side.

-- 1. Cabut update umum dan grant spesifik kolom
revoke update on public.room_players from authenticated;
grant update (is_ready, last_seen_at) on public.room_players to authenticated;

-- 2. Trigger guard untuk proteksi ganda (defense in depth)
create or replace function public.guard_room_players_self_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Izinkan jika eksekusi berasal dari service_role (RPC server)
  if (current_setting('role', true) = 'service_role' or auth.role() = 'service_role') then
    return new;
  end if;

  -- User hanya boleh mengubah is_ready dan last_seen_at
  if (old.id is distinct from new.id) or
     (old.room_id is distinct from new.room_id) or
     (old.user_id is distinct from new.user_id) or
     (old.display_name is distinct from new.display_name) or
     (old.seat_number is distinct from new.seat_number) or
     (old.is_alive is distinct from new.is_alive) or
     (old.death_cause is distinct from new.death_cause) or
     (old.died_at is distinct from new.died_at) or
     (old.joined_at is distinct from new.joined_at) or
     (old.prompt is distinct from new.prompt) or
     (old.prompt_deadline_at is distinct from new.prompt_deadline_at) then
    raise exception 'Permission denied: players may only update is_ready or last_seen_at.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_guard_room_players_update on public.room_players;
create trigger tr_guard_room_players_update
  before update on public.room_players
  for each row
  execute function public.guard_room_players_self_update();
