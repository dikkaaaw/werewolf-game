-- ===========================================================================
-- 0011_set_room_settings.sql
--
-- Feature: host-configurable phase durations in the lobby.
--
-- Why a migration is needed when the column already exists.
--
-- `rooms.settings` is jsonb with only a `jsonb_typeof = 'object'` check, so the
-- SCHEMA can hold `phaseSeconds` with no change. What it cannot do is WRITE it
-- safely. Every other game mutation in this codebase is a security-definer RPC
-- because three properties have to hold atomically in one transaction:
--
--   1. host-only, derived from `rooms.host_user_id` (never a client claim);
--   2. lobby-only, so a start that has already flipped `status` is refused;
--   3. the rooms row is locked with `for update`, which serializes this write
--      against `set_role_config` and `start_game` — both of which take the
--      same lock. Without it a settings write that passed its lobby check a
--      millisecond before `start_game` committed would land on an
--      in-progress room and change a duration the host thought was locked.
--
-- A plain `update rooms set settings = ...` from a route handler can do none
-- of that: the host/status checks would live outside the write's transaction,
-- so two concurrent requests could both pass the check and the second would
-- silently win. Keeping the check and the write in one locked statement is the
-- whole point.
--
-- Role composition deliberately gets NO new RPC: `set_role_config` (0003)
-- already validates host, lobby status, supported keys, non-negative counts
-- and that the counts sum to the current player count.
--
-- Safety: bounds below mirror SETTINGS.phaseSecondsBounds in
-- src/lib/game/settings.ts and must be kept in step with it.
-- ===========================================================================

create or replace function public.set_room_settings(
  p_room_id       uuid,
  p_user_id       uuid,
  p_phase_seconds jsonb   -- {"night":45,"day":60,"voting":30}
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room    public.rooms%rowtype;
  v_night   integer;
  v_day     integer;
  v_voting  integer;
  v_phase   text;
  v_raw     text;
  v_value   integer;
begin
  -- `for update` is load-bearing: see the header. It is the same lock
  -- set_role_config and start_game take, so settings and start cannot interleave.
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.host_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'forbidden', 'message', 'Only the host can change game settings.'));
  end if;

  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'game_already_started',
      'message', 'Game settings are locked once the game starts.'));
  end if;

  if p_phase_seconds is null or jsonb_typeof(p_phase_seconds) <> 'object' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_settings', 'message', 'Expected an object of phase durations.'));
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_phase_seconds) k
    where k not in ('night', 'day', 'voting')
  ) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'invalid_settings',
      'message', 'Only night, day and voting durations are configurable.'));
  end if;

  -- Bounds mirror SETTINGS.phaseSecondsBounds. A value outside them is refused
  -- rather than clamped: clamping would let the host believe they had set 5
  -- seconds when the game actually ran with the floor.
  --
  -- The loop variables are TEXT, not integer: `jsonb_each_text` yields text and
  -- the numeric-shape check has to run BEFORE the cast. Casting on assignment
  -- (declaring v_value integer and iterating straight into it) made the regex
  -- operator unresolvable, because by then the value was already an integer.
  for v_phase, v_raw in
    select key, value from jsonb_each_text(p_phase_seconds)
  loop
    if v_raw is null or v_raw !~ '^-?[0-9]+$' then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'invalid_settings',
        'message', format('Phase duration "%s" must be a whole number of seconds.', v_phase)));
    end if;

    v_value := v_raw::integer;

    if v_phase = 'night' and (v_value < 10 or v_value > 300) then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'invalid_settings', 'message', 'Night must be between 10 and 300 seconds.'));
    elsif v_phase = 'day' and (v_value < 10 or v_value > 600) then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'invalid_settings', 'message', 'Day must be between 10 and 600 seconds.'));
    elsif v_phase = 'voting' and (v_value < 10 or v_value > 300) then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'invalid_settings', 'message', 'Voting must be between 10 and 300 seconds.'));
    end if;
  end loop;

  -- Absent keys fall back to the existing value, then to the built-in default.
  -- A partial update therefore never zeroes the phases the host did not touch.
  v_night  := coalesce((p_phase_seconds->>'night')::integer,
                       (v_room.settings->'phaseSeconds'->>'night')::integer, 10);
  v_day    := coalesce((p_phase_seconds->>'day')::integer,
                       (v_room.settings->'phaseSeconds'->>'day')::integer, 10);
  v_voting := coalesce((p_phase_seconds->>'voting')::integer,
                       (v_room.settings->'phaseSeconds'->>'voting')::integer, 10);

  update public.rooms
     set settings = settings || jsonb_build_object(
           'phaseSeconds',
           jsonb_build_object('night', v_night, 'day', v_day, 'voting', v_voting)),
         last_activity_at = now(),
         state_version = state_version + 1,
         updated_at = now()
   where id = p_room_id;

  return jsonb_build_object('ok', true, 'phaseSeconds', jsonb_build_object(
    'night', v_night, 'day', v_day, 'voting', v_voting));
end;
$$;

-- Defence in depth: service-role only, exactly like every other mutation RPC.
revoke all on function public.set_room_settings(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_room_settings(uuid, uuid, jsonb) to service_role;
