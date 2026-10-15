/**
 * Night resolution.
 *
 * Deterministic: given the same set of actions and player states it always
 * produces the same result, regardless of the order requests arrived in or the
 * order rows came back from Postgres. See GAME-RULES.md §6.
 *
 * Resolution runs in explicit `actionPriority` order (protects land before
 * kills), which reproduces the reference implementation's effective behaviour
 * — a doctor save beats a werewolf attack — without its implicit
 * "already-dead means double-kill is skipped" coupling.
 *
 * This module is pure. It performs no I/O and mutates nothing.
 */
import { getRole } from './role-registry';
import type {
  Elimination,
  InvestigationResult,
  NightAction,
  NightResolutionResult,
  PlayerState,
} from './types';

/** Stable ordering: priority desc, then action type, then target id. */
function orderActions(actions: readonly NightAction[]): NightAction[] {
  return [...actions].sort((a, b) => {
    const pa = getRole(a.actorRoleKey)?.actionPriority ?? 0;
    const pb = getRole(b.actorRoleKey)?.actionPriority ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.actionType !== b.actionType) {
      return a.actionType < b.actionType ? -1 : 1;
    }
    if (a.targetPlayerId !== b.targetPlayerId) {
      return a.targetPlayerId < b.targetPlayerId ? -1 : 1;
    }
    return 0;
  });
}

export interface NightResolutionInput {
  players: readonly PlayerState[];
  actions: readonly NightAction[];
}

export function resolveNight(input: NightResolutionInput): NightResolutionResult {
  const { players, actions } = input;

  const byId = new Map(players.map((player) => [player.playerId, player]));
  const ordered = orderActions(actions);

  const protectedPlayerIds = new Set<string>();
  const eliminateActions: NightAction[] = [];

  // --- Pass 1: protection ---------------------------------------------------
  // `protect` has the highest priority that changes the world, so it resolves
  // first and the kill pass below can subtract it.
  for (const action of ordered) {
    if (action.actionType !== 'protect') continue;
    const target = byId.get(action.targetPlayerId);
    if (!target || !target.isAlive) continue;
    protectedPlayerIds.add(action.targetPlayerId);
  }

  // --- Pass 2: elimination (plurality across the werewolf team) -------------
  for (const action of ordered) {
    if (action.actionType === 'eliminate') eliminateActions.push(action);
  }

  const attackedPlayerIds = choosePluralityTarget(eliminateActions, byId);
  const killIds = new Set<string>();
  for (const targetId of attackedPlayerIds) {
    if (!protectedPlayerIds.has(targetId)) killIds.add(targetId);
  }

  const eliminated: Elimination[] = [];
  const seen = new Set<string>();
  for (const playerId of killIds) {
    // Guards against a malformed caller passing duplicate ids: one death each.
    if (seen.has(playerId)) continue;
    seen.add(playerId);
    const player = byId.get(playerId);
    if (!player) continue;
    eliminated.push({
      playerId: player.playerId,
      seatNumber: player.seatNumber,
      displayName: player.displayName,
      cause: 'night_elimination',
    });
  }
  // Stable public ordering.
  eliminated.sort((a, b) => a.seatNumber - b.seatNumber);

  // --- Pass 3: investigation (private results only) -------------------------
  const investigations: InvestigationResult[] = [];
  for (const action of ordered) {
    if (action.actionType !== 'investigate') continue;
    const target = byId.get(action.targetPlayerId);
    if (!target) continue;
    // The approved Seer policy (docs/ROLE-SPECIFICATION.md) preserves the
    // reference's "sneaky wuff" behavior: a Lycan reads as a Villager.
    const targetAlignment = getRole(target.roleKey)?.roleKey === 'lycan' ? 'village' : target.alignment;
    investigations.push({
      actorPlayerId: action.actorPlayerId,
      targetPlayerId: target.playerId,
      targetAlignment: targetAlignment as typeof target.alignment,
    });
  }

  // --- Pass 4: bookkeeping ---------------------------------------------------
  const savedPlayerIds = [...protectedPlayerIds].filter((id) => attackedPlayerIds.includes(id));

  return {
    public: { eliminated },
    private: { investigations },
    internal: {
      protectedPlayerIds: [...protectedPlayerIds].sort(),
      attackedPlayerIds: [...attackedPlayerIds].sort(),
      savedPlayerIds: savedPlayerIds.sort(),
    },
  };
}

/**
 * Plurality target selection.
 *
 * Ties break on the lowest seat number rather than randomly: it is
 * deterministic (so tests and replays are stable) and independent of the
 * action-arrival order.
 */
function choosePluralityTarget(
  actions: readonly NightAction[],
  byId: ReadonlyMap<string, PlayerState>,
): string[] {
  if (actions.length === 0) return [];

  const counts = new Map<string, number>();
  for (const action of actions) {
    const target = byId.get(action.targetPlayerId);
    if (!target || !target.isAlive) continue;
    counts.set(target.playerId, (counts.get(target.playerId) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  let best = -1;
  for (const count of counts.values()) {
    if (count > best) best = count;
  }

  const tied = [...counts.entries()].filter(([, count]) => count === best);

  // Stable tie-break: lowest seat number wins.
  tied.sort((a, b) => {
    const seatA = byId.get(a[0])?.seatNumber ?? Number.MAX_SAFE_INTEGER;
    const seatB = byId.get(b[0])?.seatNumber ?? Number.MAX_SAFE_INTEGER;
    return seatA - seatB;
  });

  return [tied[0][0]];
}
