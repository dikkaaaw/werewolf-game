-- ===========================================================================
-- 0004_fix_gen_random_bytes_qualification.sql
--
-- Fix: function gen_random_bytes(integer) does not exist
--
-- In Supabase, the `pgcrypto` extension is installed into the `extensions`
-- schema. Because `public.create_room` specifies an explicit
-- `set search_path = public, pg_temp` (for security definer hardening),
-- unqualified calls to `gen_random_bytes` fail to resolve.
--
-- We qualify the call as `extensions.gen_random_bytes(1)` directly while keeping
-- `search_path = public, extensions, pg_temp` for maximum compatibility.
-- All function signatures, random room-code generation logic, uniqueness checks,
-- and service-role-only EXECUTE permissions remain identical.
-- ===========================================================================

create or replace function public.create_room(
  p_user_id      uuid,
  p_display_name text,
  p_max_players  integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_alphabet   constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 31 symbols, no I/O/0/1
  v_code       text;
  v_room       uuid;
  v_player     uuid;
  v_max        integer;
  v_attempts   integer := 0;
  v_byte       integer;
begin
  v_max := greatest(2, least(coalesce(p_max_players, 20), 20));

  -- Rejection sampling: 31*8 = 248 is the largest multiple of the alphabet size
  -- that fits in a byte, so bytes >= 248 are discarded rather than folded in
  -- with a modulo bias. The retry loop also resolves the (astronomically
  -- unlikely) unique-constraint collision under concurrent creation.
  loop
    v_code := '';
    for i in 1..6 loop
      v_byte := get_byte(extensions.gen_random_bytes(1), 0);
      if v_byte >= 248 then
        continue;                       -- reject this character, redraw below
      end if;
      v_code := v_code || substr(v_alphabet, (v_byte % 31) + 1, 1);
    end loop;

    v_attempts := v_attempts + 1;

    exit when length(v_code) = 6;
    exit when v_attempts > 20;          -- give up rather than spin forever
  end loop;

  if length(v_code) <> 6 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'code_generation_failed', 'message', 'Could not allocate a room code.'));
  end if;

  begin
    insert into public.rooms (room_code, host_user_id, max_players, expires_at)
    values (v_code, p_user_id, v_max, now() + interval '2 hours')
    returning id into v_room;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'code_collision', 'message', 'Room code collision; please retry.'));
  end;

  -- The host is an ordinary player and takes seat 1.
  insert into public.room_players (room_id, user_id, display_name, seat_number)
  values (v_room, p_user_id, trim(p_display_name), 1)
  returning id into v_player;

  insert into public.game_events (room_id, event_type, public_payload)
  values (v_room, 'player_joined', jsonb_build_object(
    'playerId', v_player,
    'displayName', trim(p_display_name),
    'seatNumber', 1
  ));

  return jsonb_build_object(
    'ok', true,
    'roomId', v_room,
    'roomCode', v_code,
    'playerId', v_player,
    'seatNumber', 1,
    'maxPlayers', v_max
  );
end;
$$;

-- Defence in depth: only service_role may execute.
revoke all on function public.create_room(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.create_room(uuid, text, integer) to service_role;
