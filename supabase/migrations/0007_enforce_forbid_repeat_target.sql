-- ===========================================================================
-- 0007_enforce_forbid_repeat_target.sql
--
-- Fix: `forbidRepeatTarget` was declared in the TypeScript role registry and
-- checked in `src/lib/game/action-validation.ts`, but NEITHER is on the runtime
-- path. Authoritative validation lives in `submit_night_action`, which never
-- consulted the rule — so a Doctor could protect the same player every single
-- night and nothing stopped them.
--
-- Rule (confirmed against the normative docs before implementing):
--   * GAME-RULES.md §5, validation step 2.7 — "Role `targetRules` satisfied
--     (self-targeting, repeat-target)."
--   * REFERENCE-ANALYSIS.md §3 — "Same-player repeat across rounds is allowed
--     except where a role config sets `forbidRepeatTarget: true`."
--   * Only `doctor` sets it (src/lib/game/role-registry.ts), and the rejection
--     message reads "You cannot protect the same player two nights running."
--
-- INTERPRETATION (documented because the docs are terse): "repeat across
-- rounds" means the IMMEDIATELY PRECEDING round. A Doctor may protect player A
-- in round 1 and again in round 3, but not in two consecutive rounds. Round 1
-- has no predecessor, so any target is legal there.
--
-- WHY SQL AND NOT TYPESCRIPT: the project keeps game-state authority in the
-- database. `validateNightAction` is a pure specification module with unit
-- tests, but a browser or a direct RPC caller must not be able to bypass it.
-- This mirrors the existing pattern in the same function, which already
-- derives the permitted action type from `player_secrets.role_key` rather than
-- trusting the request.
--
-- Only adds a rejection: the upsert path is untouched, so re-submitting within
-- the SAME round still replaces the action as GAME-RULES §5 requires.
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

-- Grants unchanged: service-role only, exactly as before.
revoke all on function public.submit_night_action(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.submit_night_action(uuid, uuid, text, uuid) to service_role;