/**
 * Phase state machine and deadlines.
 *
 * Owns the single question "what happens next", so no handler has to re-derive
 * it. Deadlines are always computed from the *server's* clock — the browser
 * countdown is display-only and is never consulted here (PRD §17.2).
 */
import { SETTINGS } from './settings';
import type { GamePhase } from './types';

const LEGAL_TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  lobby: ['night'],
  night: ['day', 'finished'],
  day: ['voting'],
  voting: ['night', 'finished'],
  finished: [],
};

export function isLegalTransition(from: GamePhase, to: GamePhase): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertLegalTransition(from: GamePhase, to: GamePhase): void {
  if (!isLegalTransition(from, to)) {
    throw new Error(`Illegal phase transition ${from} → ${to}`);
  }
}

export function legalTransitions(from: GamePhase): readonly GamePhase[] {
  return LEGAL_TRANSITIONS[from] ?? [];
}

const ACTIVE_PHASE_DURATION_KEYS = {
  night: 'night',
  day: 'day',
  voting: 'voting',
} as const;

export type ActivePhase = keyof typeof ACTIVE_PHASE_DURATION_KEYS;

/** Phases that carry a running deadline. `lobby` and `finished` do not. */
export function isActivePhase(phase: GamePhase): phase is ActivePhase {
  return phase === 'night' || phase === 'day' || phase === 'voting';
}

export type PhaseDurationOverrides = Partial<Record<ActivePhase, number>>;

/**
 * Duration for a phase, after applying room overrides and clamping them into
 * the allowed range. An out-of-range override is clamped rather than rejected
 * here — schema-level validation is what rejects it at the API boundary; this
 * is a last line of defence so a bad DB row cannot produce an absurd deadline.
 */
export function phaseDurationSeconds(
  phase: ActivePhase,
  overrides: PhaseDurationOverrides = {},
): number {
  const key = ACTIVE_PHASE_DURATION_KEYS[phase];
  const bounds = SETTINGS.phaseSecondsBounds[key];
  const requested = overrides[key];

  if (requested === undefined || !Number.isFinite(requested)) {
    return SETTINGS.phaseSeconds[key];
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(requested)));
}

/** `phase_ends_at` for a phase starting at `from`. `finished` has no deadline. */
export function computePhaseDeadline(
  phase: GamePhase,
  from: Date,
  overrides: PhaseDurationOverrides = {},
): Date | null {
  if (!isActivePhase(phase)) return null;
  return new Date(from.getTime() + phaseDurationSeconds(phase, overrides) * 1000);
}

export function isPhaseExpired(phaseEndsAt: string | Date | null, now: Date = new Date()): boolean {
  if (!phaseEndsAt) return false;
  const deadline = phaseEndsAt instanceof Date ? phaseEndsAt : new Date(phaseEndsAt);
  return now.getTime() >= deadline.getTime();
}

export interface NextPhaseDecision {
  nextPhase: GamePhase;
  /** `round_number` for the next phase. */
  roundNumber: number;
  /** Seconds until the next deadline; 0 when there is no deadline. */
  durationSeconds: number;
}

/**
 * Where the game goes after a phase is resolved.
 *
 * `night` → `day` → `voting` → `night`, with `finished` whenever the caller has
 * already detected a winner. `round_number` increments on every entry into
 * `night`, so it identifies the night AND the voting phase that follows it.
 */
export function decideNextPhase(params: {
  from: GamePhase;
  roundNumber: number;
  gameOver: boolean;
  overrides?: PhaseDurationOverrides;
}): NextPhaseDecision {
  const { from, roundNumber, gameOver, overrides } = params;

  if (gameOver) {
    assertLegalTransition(from, 'finished');
    return { nextPhase: 'finished', roundNumber, durationSeconds: 0 };
  }

  let next: GamePhase;
  switch (from) {
    case 'night':
      next = 'day';
      break;
    case 'day':
      next = 'voting';
      break;
    case 'voting':
      next = 'night';
      break;
    default:
      throw new Error(`Cannot advance from phase "${from}"`);
  }

  assertLegalTransition(from, next);

  const nextRound = next === 'night' ? roundNumber + 1 : roundNumber;
  const duration = isActivePhase(next) ? phaseDurationSeconds(next, overrides) : 0;

  return { nextPhase: next, roundNumber: nextRound, durationSeconds: duration };
}
