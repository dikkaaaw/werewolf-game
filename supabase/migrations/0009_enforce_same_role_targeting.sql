-- ===========================================================================
-- 0009_enforce_same_role_targeting.sql
--
-- A1: a Werewolf may not eliminate another Werewolf.
-- A2: a Doctor may not protect another Doctor.
--
-- Both are enforced HERE, in the authoritative RPC, not only in the TypeScript
-- validator. A browser or a direct RPC caller must not be able to bypass them,
-- and the role identity is read from `player_secrets` on both sides — never
-- from the request body.
--
-- WHY A MIGRATION: `submit_night_action` is the single authoritative validation
-- point for night actions. The rule needs the target's assigned role, which lives
-- in another table, so it cannot be expressed as a same-table CHECK constraint
-- (unlike `game_actions_no_self_target_chk`). Recreating the function is the
-- established project pattern for adding a rule to it (see 0007).
--
-- SCOPE: only adds rejections. The upsert path is untouched, so re-submitting
-- within the same round still replaces the prior action, and the existing
-- self-target / dead-target / foreign-room / phase / repeat-target checks keep
-- their order and semantics. Plurality and the lowest-seat tie-break are
-- unchanged.
--
-- No schema change: no new column, no new constraint, no new table.
-- ===========================================================================

create or replace function public.submit_night_action(
  p_room_id     uuid,
  p_user_id     uuid,
  p_action_type text,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room          public.rooms%rowtype;
  v_actor         public.room_players%rowtype;
  v_target        public.room_players%rowtype;
  v_secret        public.player_secrets%rowtype;
  v_expected      text;
  v_forbid_repeat boolean;
  v_prev_target   uuid;
  v_target_secret public.player_secrets%rowtype;
begin
  select * into v_room from public.rooms where id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_found', 'message', 'Room not found.'));
  end if;

  if v_room.status <> 'in_progress' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'room_not_in_progress', 'message', 'The game is not running.'));
  end if;

  -- Deadline is server time, always.
  if v_room.phase <> 'night' or v_room.phase_ends_at is null or v_room.phase_ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_night_phase', 'message', 'The night phase is over.'));
  end if;

  select * into v_actor from public.room_players rp
   where rp.room_id = p_room_id and rp.user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'not_a_member', 'message', 'You are not in this room.'));
  end if;

  if not v_actor.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'player_not_alive', 'message', 'Eliminated players cannot act.'));
  end if;

  select * into v_secret from public.player_secrets where player_id = v_actor.id;

  if not found or v_secret.role_key is null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'role_not_assigned', 'message', 'Your role has not been assigned yet.'));
  end if;

  -- The role's capability comes from the secret table, never from the request.
  -- `forbid_repeat_target` is derived from the same registry source the
  -- TypeScript engine reads, so the two cannot drift apart silently.
  select case v_secret.role_key
           when 'werewolf' then 'eliminate'
           when 'seer'     then 'investigate'
           when 'doctor'   then 'protect'
           else null
         end,
         case v_secret.role_key
           when 'doctor' then true   -- role-registry.ts: forbidRepeatTarget: true
           else false
         end
    into v_expected, v_forbid_repeat;

  if v_expected is null or v_expected <> p_action_type then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'action_not_supported_by_role',
      'message', 'Your role cannot perform that action.'));
  end if;

  select * into v_target from public.room_players rp
   where rp.id = p_target_player_id and rp.room_id = p_room_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_not_in_room', 'message', 'That player is not in this room.'));
  end if;

  if v_target.id = v_actor.id then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_is_self', 'message', 'You cannot target yourself.'));
  end if;

  if not v_target.is_alive then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_dead', 'message', 'That player has been eliminated.'));
  end if;

  -- Trusted role data for the TARGET, read from player_secrets exactly as the
  -- actor's role is. Never taken from the request.
  select * into v_target_secret from public.player_secrets where player_id = v_target.id;

  -- A1: a Werewolf may not eliminate another Werewolf. If the target has no
  -- secret row the comparison is NULL and the guard is skipped (fail open for
  -- a targeting restriction); the authoritative data path always has one.
  if v_secret.role_key = 'werewolf' and v_target_secret.role_key = 'werewolf' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_is_werewolf',
      'message', 'Werewolves cannot target another Werewolf.'));
  end if;

  -- A2: a Doctor may not protect another Doctor. Not implied by the default
  -- single-Doctor configuration, so it is a rule, not a consequence of it.
  if v_secret.role_key = 'doctor' and v_target_secret.role_key = 'doctor' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'target_is_doctor',
      'message', 'A Doctor cannot protect another Doctor.'));
  end if;

  -- Consecutive-round repeat guard (doctor only). Scoped to this room, this
  -- actor, this action type, and the immediately preceding round.
  if v_forbid_repeat then
    select ga.target_player_id into v_prev_target
      from public.game_actions ga
     where ga.room_id = p_room_id
       and ga.actor_player_id = v_actor.id
       and ga.action_type = p_action_type::night_action_type
       and ga.round_number = v_room.round_number - 1;

    if v_prev_target is not null and v_prev_target = v_target.id then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'repeat_target_forbidden',
        'message', 'You cannot protect the same player two nights running.'));
    end if;
  end if;

  -- One active action per type per round; re-submitting replaces the old one.
  insert into public.game_actions
    (room_id, round_number, actor_player_id, action_type, target_player_id)
  values
    (p_room_id, v_room.round_number, v_actor.id, p_action_type::night_action_type, v_target.id)
  on conflict (room_id, round_number, actor_player_id, action_type)
  do update set target_player_id = excluded.target_player_id, updated_at = now();

  update public.rooms set last_activity_at = now() where id = p_room_id;

  return jsonb_build_object('ok', true, 'roundNumber', v_room.round_number);
end;
$$;

-- Grants restated, matching the convention in 0006, 0007 and 0008.
revoke all on function public.submit_night_action(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.submit_night_action(uuid, uuid, text, uuid) to service_role;
