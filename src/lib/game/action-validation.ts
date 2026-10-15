import { canonicalRoleKey, getRole } from './role-registry';
/**
 * Night action validation.
 *
 * Every rule here is server-enforced. The client sends an action and shows an
 * optimistic UI, but this module — never the frontend — decides whether the
 * action is legal.
 *
 * Ordering matters and is intentional: cheap existence/phase checks first,
 * then role capability, then target legality. This keeps error messages
 * specific without leaking information a player is not entitled to.
 */
import type { GamePhase, NightActionType, PlayerState } from './types';

export type ActionRejectionCode =
  | 'room_not_in_progress'
  | 'wrong_phase'
  | 'phase_expired'
  | 'player_not_alive'
  | 'player_not_in_room'
  | 'role_cannot_act'
  | 'action_not_supported_by_role'
  | 'target_not_in_room'
  | 'target_is_self'
  | 'target_dead'
  | 'same_role_target_forbidden'
  | 'target_is_werewolf'
  | 'repeat_target_forbidden';

export type ActionValidationResult =
  | { ok: true }
  | { ok: false; code: ActionRejectionCode; message: string };

export interface ActionValidationInput {
  actor: PlayerState | undefined;
  target: PlayerState | undefined;
  actionType: NightActionType;
  phase: GamePhase;
  roomStatus: 'lobby' | 'in_progress' | 'finished';
  phaseExpired: boolean;
  /** The actor's target in the previous round, for `forbidRepeatTarget`. */
  previousTargetPlayerId?: string | null;
}

export function validateNightAction(input: ActionValidationInput): ActionValidationResult {
  const {
    actor,
    target,
    actionType,
    phase,
    roomStatus,
    phaseExpired,
    previousTargetPlayerId,
  } = input;

  // --- Room and phase ---------------------------------------------------------
  if (roomStatus !== 'in_progress') {
    return fail('room_not_in_progress', 'The game has not started or is already over.');
  }
  if (phase !== 'night') {
    return fail('wrong_phase', 'Night actions are only accepted during the night phase.');
  }
  if (phaseExpired) {
    return fail('phase_expired', 'The night phase has ended.');
  }

  // --- Actor ------------------------------------------------------------------
  if (!actor) {
    return fail('player_not_in_room', 'You are not a member of this room.');
  }
  if (!actor.isAlive) {
    return fail('player_not_alive', 'Eliminated players cannot act.');
  }

  // --- Role capability --------------------------------------------------------
  const role = getRole(actor.roleKey);
  if (!role) {
    return fail('role_cannot_act', 'Your role has no available action.');
  }
  if (!role.nightAction) {
    return fail('role_cannot_act', 'Your role has no night action.');
  }
  if (role.nightAction !== actionType) {
    return fail('action_not_supported_by_role', 'Your role cannot perform that action.');
  }

  // --- Target -----------------------------------------------------------------
  if (!target) {
    return fail('target_not_in_room', 'That player is not in this room.');
  }

  // Self-targeting is unconditionally illegal in the MVP. A previous
  // `allowSelfProtect` config flag existed here but was never honoured by the
  // authoritative RPC, so it could only ever mislead — it has been removed.
  if (!role.targetRules.canTargetSelf && target.playerId === actor.playerId) {
    return fail('target_is_self', 'You cannot target yourself.');
  }

  if (!role.targetRules.canTargetDead && !target.isAlive) {
    return fail('target_dead', 'That player has already been eliminated.');
  }

  // A1/A2: a Werewolf may not eliminate another Werewolf and a Guardian Angel
  // may not protect another Guardian Angel. `target.roleKey` comes from the
  // trusted roster. A Lycan is also wolf-aligned, so wolves cannot target one.
  if (
    !role.targetRules.canTargetSameRole &&
    target.roleKey &&
    canonicalRoleKey(target.roleKey) === canonicalRoleKey(actor.roleKey)
  ) {

    return fail(
      'same_role_target_forbidden',
      role.roleKey === 'werewolf'
        ? 'Werewolves cannot target another Werewolf.'
        : 'A Guardian Angel cannot protect another Guardian Angel.',
    );
  }

  if (role.roleKey === 'werewolf' && target.alignment === 'werewolf') {
    return fail('target_is_werewolf', 'Werewolves cannot target another Wolf.');
  }

  if (role.targetRules.forbidRepeatTarget && previousTargetPlayerId === target.playerId) {
    return fail('repeat_target_forbidden', 'You cannot protect the same player two nights running.');
  }


  return { ok: true };
}

function fail(code: ActionRejectionCode, message: string): ActionValidationResult {
  return { ok: false, code, message };
}
