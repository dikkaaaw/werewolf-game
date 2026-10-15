/**
 * Core game domain types. Shared by the engine, the API layer and the client.
 * These mirror the Postgres enums in migration 0001.
 */
import type { z } from 'zod';

export const ALIGNMENTS = ['werewolf', 'village', 'neutral'] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export const ROOM_STATUSES = ['lobby', 'in_progress', 'finished'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const GAME_PHASES = ['lobby', 'night', 'day', 'voting', 'finished'] as const;
export type GamePhase = (typeof GAME_PHASES)[number];

export const NIGHT_ACTION_TYPES = ['eliminate', 'investigate', 'protect'] as const;
export type NightActionType = (typeof NIGHT_ACTION_TYPES)[number];

export const KILL_CAUSES = ['night_elimination', 'vote_elimination', 'hunter_shot'] as const;
export type KillCause = (typeof KILL_CAUSES)[number];

export const VOTE_TIE_RULES = ['none', 'random'] as const;
/** `none` = a tied vote eliminates nobody (default). `random` = pick uniformly. */
export type VoteTieRule = (typeof VOTE_TIE_RULES)[number];

export const EVENT_TYPES = [
  'player_joined',
  'player_left',
  'game_started',
  'night_started',
  'day_started',
  'voting_started',
  'player_eliminated',
  'night_result_public',
  'vote_result',
  'game_finished',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Per-round shape of the secret data a role accumulates (e.g. seer memories). */
export interface PrivateState {
  /** Seer's per-target alignment readings, keyed by player id. */
  investigations?: Record<string, Alignment>;
  /** Doctor's targets protected in the current round (engine bookkeeping). */
  protectedPlayerIds?: string[];
  [key: string]: unknown;
}

export interface RoleDefinition {
  roleKey: string;
  displayName: string;
  description: string;
  alignment: Alignment;
  /** Night action this role may submit, or `null` if it has no night action. */
  nightAction: NightActionType | null;
  /**
   * Higher resolves first. See GAME-RULES.md §6.
   * `null` for roles with no night action.
   */
  actionPriority: number | null;
  targetRules: TargetRules;
  /** Alignment this role's presence contributes to when checking win conditions. */
  countsForWinAs: Alignment;
  /**
   * Zod schema for this role's entry in `room_role_configs.config`.
   * Room configuration is validated against it before the game starts, so an
   * unsupported option can never reach the engine.
   */
  configSchema: z.ZodType<Record<string, unknown>>;
}

export interface TargetRules {
  canTargetSelf: boolean;
  /** May target an already-dead player (e.g. a corpse-reading role). */
  canTargetDead: boolean;
  /**
   * When true, the role may not pick the same target in consecutive rounds.
   * Requires `previousTargetPlayerId` to be supplied by the caller.
   */
  forbidRepeatTarget: boolean;
  /**
   * May target another player holding the SAME role.
   *
   * `false` for `werewolf` (A1: a wolf may not eliminate a teammate) and for
   * `doctor` (A2: a Doctor may not protect another Doctor). Roles without this
   * restriction default to `true` — e.g. a Seer may inspect another Seer.
   *
   * This is a restriction on targeting, not a privacy boundary, so a target whose
   * secret is somehow absent is treated as "not provably the same role" and the
   * check is skipped rather than failing the action.
   */
  canTargetSameRole: boolean;
}

export interface RoleConfigEntry {
  roleKey: string;
  roleCount: number;
  config: Record<string, unknown>;
}

export interface PlayerState {
  playerId: string;
  userId: string;
  seatNumber: number;
  displayName: string;
  isAlive: boolean;
  alignment: Alignment;
  roleKey: string;
}

export interface NightAction {
  actorPlayerId: string;
  actorRoleKey: string;
  actionType: NightActionType;
  targetPlayerId: string;
}

export interface Elimination {
  playerId: string;
  seatNumber: number;
  displayName: string;
  cause: KillCause;
  /** Alignment is intentionally omitted: reveal policy is applied at publish time. */
}

export interface InvestigationResult {
  actorPlayerId: string;
  targetPlayerId: string;
  targetAlignment: Alignment;
}

/** Result buckets are deliberately disjoint — see GAME-RULES.md §6. */
export interface NightResolutionResult {
  /** Announced to the whole room. Never contains roles, killers, or targets. */
  public: {
    eliminated: Elimination[];
  };
  /** Visible only to the owning player, via an ownership-checked endpoint. */
  private: {
    investigations: InvestigationResult[];
  };
  /** Engine bookkeeping. Never persisted, never sent anywhere. */
  internal: {
    protectedPlayerIds: string[];
    attackedPlayerIds: string[];
    savedPlayerIds: string[];
  };
}

export interface VoteRecord {
  voterPlayerId: string;
  targetPlayerId: string;
}

export interface VoteTally {
  targetPlayerId: string;
  count: number;
}

export interface VoteResolutionResult {
  eliminated: Elimination | null;
  tally: VoteTally[];
  /** Populated when a tie was broken randomly, for the audit trail. */
  tieBroken: boolean;
  tiedPlayerIds: string[];
  reason: 'elected' | 'tie_no_elimination' | 'no_votes' | 'tie_random';
}

export interface WinResult {
  hasWinner: boolean;
  winningAlignment: Alignment | null;
  aliveWerewolves: number;
  aliveNonWerewolves: number;
  /** Alignments that have no living members left — used to build the reveal payload. */
  eliminatedAlignments: Alignment[];
}
