-- 0038_host_migration.sql
--
-- Host Migration Mechanism (P0):
-- 1. Memperbaiki bug tipe data pada leave_room (mengganti boolean menjadi uuid untuk v_new_host_user_id).
-- 2. Di Lobby: jika host keluar, hak host otomatis berpindah ke pemain dengan seat_number terendah yang tersisa.
-- 3. Di Mid-Game: host yang keluar tidak menghentikan permainan (pg_cron terus memajukan fase).
-- 4. Di Finished / Re-Lobby: host baru dengan seat terendah dapat diserahkan hak start game berikutnya.
-- 5. Memperbarui guard_room_players_self_update agar mengizinkan konteks superuser/postgres.

create or replace function public.guard_room_players_self_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Izinkan jika eksekusi berasal dari service_role / superuser / RPC server
  if (current_setting('role', true) in ('service_role', 'postgres') or 
      auth.role() in ('service_role', 'postgres') or 
      session_user in ('postgres', 'supabase_admin')) then
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

create or replace function public.leave_room(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room               public.rooms%rowtype;
  v_player             public.room_players%rowtype;
  v_new_host_user_id   uuid;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  select * into v_player from public.room_players rp
   where rp.room_id = p_room_id and rp.user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_a_member', 'message', 'You are not in this room.'));
  end if;

  -- 1. KONDISI LOBBY: Hapus dari daftar pemain dan pindahkan host jika yang keluar adalah host
  if v_room.status = 'lobby' then
    delete from public.room_players where id = v_player.id;

    if v_room.host_user_id = p_user_id then
      select rp.user_id into v_new_host_user_id
      from public.room_players rp
      where rp.room_id = p_room_id
      order by rp.seat_number asc
      limit 1;

      if found then
        update public.rooms
           set host_user_id = v_new_host_user_id,
               last_activity_at = now(),
               state_version = state_version + 1
         where id = p_room_id;
      else
        update public.rooms
           set status = 'finished',
               phase = 'finished',
               phase_ends_at = null,
               expires_at = now() + interval '24 hours',
               state_version = state_version + 1
         where id = p_room_id;
      end if;
    end if;

    insert into public.game_events (room_id, event_type, public_payload)
    values (p_room_id, 'player_left', jsonb_build_object(
      'displayName', v_player.display_name,
      'seatNumber', v_player.seat_number,
      'wasHost', (v_room.host_user_id = p_user_id),
      'newHostUserId', v_new_host_user_id
    ));

    update public.rooms
       set last_activity_at = now(),
           state_version = state_version + 1
     where id = p_room_id;

    return jsonb_build_object(
      'ok', true,
      'removedFromLobby', true,
      'newHostUserId', v_new_host_user_id
    );
  end if;

  -- 2. KONDISI IN_PROGRESS: Tandai pemain gugur (left_game), jangan hapus riwayat aksi/vote
  if v_player.is_alive then
    update public.room_players
       set is_alive = false,
           death_cause = 'vote_elimination',
           died_at = now(),
           last_seen_at = now()
     where id = v_player.id;

    insert into public.game_events (room_id, event_type, public_payload, round_number)
    values (p_room_id, 'player_eliminated', jsonb_build_object(
      'playerId', v_player.id,
      'displayName', v_player.display_name,
      'seatNumber', v_player.seat_number,
      'reason', 'left_game'
    ), v_room.round_number);
  end if;

  -- 3. JIKA SUDAH FINISHED & HOST KELUAR: Pindahkan host ke pemain tersisa
  if v_room.status = 'finished' and v_room.host_user_id = p_user_id then
    select rp.user_id into v_new_host_user_id
    from public.room_players rp
    where rp.room_id = p_room_id
    order by rp.seat_number asc
    limit 1;

    if found then
      update public.rooms
         set host_user_id = v_new_host_user_id,
             state_version = state_version + 1
       where id = p_room_id;
    end if;
  end if;

  update public.rooms
     set last_activity_at = now(),
         state_version = state_version + 1
   where id = p_room_id;

  return jsonb_build_object('ok', true, 'markedEliminated', true);
end;
$$;

revoke all on function public.leave_room(uuid, uuid) from public, anon, authenticated;
grant execute on function public.leave_room(uuid, uuid) to service_role;
