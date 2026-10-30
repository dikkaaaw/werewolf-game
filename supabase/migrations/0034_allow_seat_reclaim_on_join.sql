-- 0034_allow_seat_reclaim_on_join.sql
--
-- Memperbaiki RPC join_room agar mendukung Reclaim Kursi / Reconnect:
-- Jika user_id pemanggil sudah terdaftar di room_players (baik status lobby maupun in_progress),
-- fungsi mengembalikan ok: true dan data kursi yang sama, alih-alih melempar error 'already_joined'
-- atau 'room_in_progress'.

create or replace function public.join_room(
  p_room_code   text,
  p_user_id     uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room       public.rooms%rowtype;
  v_player_id  uuid;
  v_seat       integer;
  v_player_count integer;
  v_code       text;
begin
  v_code := upper(trim(p_room_code));

  -- Lock row kamar
  select * into v_room
  from public.rooms
  where room_code = v_code
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'No room with that code.'));
  end if;

  if v_room.expires_at is not null and v_room.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_expired', 'message', 'That lobby has expired.'));
  end if;

  -- 1. RECLAIM SEAT / RECONNECT CHECK
  -- Jika pemain sudah pernah bergabung ke kamar ini, langsung izinkan reclaim kursi
  select rp.id, rp.seat_number into v_player_id, v_seat
  from public.room_players rp
  where rp.room_id = v_room.id and rp.user_id = p_user_id;

  if v_player_id is not null then
    -- Perbarui display name jika berubah dan update last_seen_at
    update public.room_players
       set display_name = trim(p_display_name),
           last_seen_at = now()
     where id = v_player_id;

    update public.rooms
       set last_activity_at = now(),
           state_version = state_version + 1
     where id = v_room.id;

    return jsonb_build_object(
      'ok', true,
      'rejoined', true,
      'roomId', v_room.id,
      'roomCode', v_room.room_code,
      'playerId', v_player_id,
      'seatNumber', v_seat
    );
  end if;

  -- 2. Jika pemain baru ingin join, game harus masih berstatus lobby
  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_in_progress', 'message', 'That game has already started.'));
  end if;

  select count(*) into v_player_count from public.room_players rp where rp.room_id = v_room.id;

  if v_player_count >= v_room.max_players then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_full', 'message', 'That room is full.'));
  end if;

  -- Cari kursi kosong terendah
  select coalesce(min(gap), 1) into v_seat
  from (
    select s as gap
    from generate_series(1, v_room.max_players) as s
    where not exists (
      select 1 from public.room_players rp
      where rp.room_id = v_room.id and rp.seat_number = s
    )
  ) free_seats;

  insert into public.room_players (room_id, user_id, display_name, seat_number)
  values (v_room.id, p_user_id, trim(p_display_name), v_seat)
  returning id into v_player_id;

  update public.rooms
    set last_activity_at = now(),
        expires_at = now() + interval '2 hours',
        state_version = state_version + 1
    where id = v_room.id;

  insert into public.game_events (room_id, event_type, public_payload)
  values (v_room.id, 'player_joined', jsonb_build_object(
    'playerId', v_player_id,
    'displayName', trim(p_display_name),
    'seatNumber', v_seat
  ));

  return jsonb_build_object(
    'ok', true,
    'rejoined', false,
    'roomId', v_room.id,
    'roomCode', v_room.room_code,
    'playerId', v_player_id,
    'seatNumber', v_seat,
    'playerCount', v_player_count + 1
  );
end;
$$;

revoke all on function public.join_room(text, uuid, text) from public, anon, authenticated;
grant execute on function public.join_room(text, uuid, text) to service_role;
