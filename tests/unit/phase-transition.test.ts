import { describe, expect, it } from 'vitest';

import {
  PHASE_ANNOUNCEMENT_MS,
  PHASE_ANNOUNCEMENT_STAGES,
  announcementDurationMs,
  hasActiveAnnouncement,
  initialPhaseTransitionState,
  isAnnouncedPhase,
  phaseTransitionReducer,
  type PhaseThemeKey,
  type PhaseTransitionState,
} from '@/lib/game/phase-transition';

const SCOPE = 'room-1@2026-01-01T00:00:00Z';
const OTHER_SCOPE = 'room-2@2026-01-01T00:00:00Z';

function observe(
  state: PhaseTransitionState,
  key: PhaseThemeKey,
  roundNumber = 1,
  scope = SCOPE,
) {
  return phaseTransitionReducer(state, { type: 'observed', scope, key, roundNumber });
}

describe('Phase transitions — first observation', () => {
  it('stays silent on the very first snapshot (page load)', () => {
    const loaded = observe(initialPhaseTransitionState, 'night', 1);

    expect(loaded.active).toBeNull();
    expect(hasActiveAnnouncement(loaded)).toBe(false);
    expect(loaded.lastKey).toBe('night');
    expect(loaded.scope).toBe(SCOPE);
  });

  it('stays silent when loading straight into a finished game', () => {
    const loaded = observe(initialPhaseTransitionState, 'gameover', 5);

    expect(loaded.active).toBeNull();
    expect(loaded.lastKey).toBe('gameover');
  });

  it('stays silent when loading straight into voting', () => {
    expect(observe(initialPhaseTransitionState, 'voting', 2).active).toBeNull();
  });
});

describe('Phase transitions — genuine changes', () => {
  it('announces night on the first real transition', () => {
    const state = observe(observe(initialPhaseTransitionState, 'lobby'), 'night', 1);

    expect(state.active).not.toBeNull();
    expect(state.active?.key).toBe('night');
    expect(state.active?.headline).toBe('Night Falls');
    expect(state.active?.roundNumber).toBe(1);
    expect(state.active?.id).toBe(1);
  });

  it('announces day, then voting, then the next night', () => {
    let state = observe(initialPhaseTransitionState, 'night', 1);
    state = observe(state, 'day', 1);
    expect(state.active?.key).toBe('day');
    expect(state.active?.headline).toBe('Daybreak');

    state = observe(state, 'voting', 1);
    expect(state.active?.key).toBe('voting');
    expect(state.active?.headline).toBe('The Vote');

    state = observe(state, 'night', 2);
    expect(state.active?.key).toBe('night');
    expect(state.active?.roundNumber).toBe(2);
  });

  it('gives each announcement a fresh monotonic id', () => {
    let state = observe(initialPhaseTransitionState, 'night', 1);
    const first = state.active?.id;

    state = observe(state, 'day', 1);
    const second = state.active?.id;
    state = observe(state, 'voting', 1);
    const third = state.active?.id;

    expect(second).toBeGreaterThan(first ?? 0);
    expect(third).toBeGreaterThan(second ?? 0);
  });

  it('stays silent for the lobby beat', () => {
    const state = observe(observe(initialPhaseTransitionState, 'gameover'), 'lobby');
    expect(state.active).toBeNull();
  });

  it('leaves game over to the panel animation, and still records the key', () => {
    const state = observe(observe(initialPhaseTransitionState, 'voting', 1), 'gameover', 1);

    expect(state.active).toBeNull();
    expect(state.lastKey).toBe('gameover');
  });

  it('handles a direct night -> game over jump', () => {
    const state = observe(observe(initialPhaseTransitionState, 'night', 1), 'gameover', 1);

    expect(state.active).toBeNull();
    expect(state.lastKey).toBe('gameover');
    // The next genuine change is still detected from the right baseline.
    expect(observe(state, 'night', 2).active?.key).toBe('night');
  });

  it('carries the current round number into the announcement', () => {
    const state = observe(observe(initialPhaseTransitionState, 'night', 3), 'day', 4);
    expect(state.active?.roundNumber).toBe(4);
  });
});

describe('Phase transitions — must not replay', () => {
  it('ignores ordinary Realtime events that return the same phase', () => {
    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'day', 1);

    // Same phase, many times over — the exact shape of a Realtime burst.
    let state = playing;
    for (let i = 0; i < 10; i += 1) {
      state = observe(state, 'day', 1);
    }

    // Object identity is preserved, so no React state update and no replay.
    expect(state).toBe(playing);
    expect(state.active).toBe(playing.active);
  });

  it('leaves an in-flight announcement untouched by a poll', () => {
    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'day', 1);
    const polled = observe(playing, 'day', 1);

    expect(polled).toBe(playing);
    expect(polled.active?.id).toBe(playing.active?.id);
  });

  it('does not replay on a reconnect that re-reads the current phase', () => {
    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'voting', 2);
    const reconnected = observe(playing, 'voting', 2);

    expect(reconnected).toBe(playing);
    expect(hasActiveAnnouncement(reconnected)).toBe(true);
  });

  it('is silent on the very first snapshot after a reconnect into a fresh scope', () => {
    const reconnected = observe(initialPhaseTransitionState, 'night', 4, OTHER_SCOPE);

    expect(reconnected.active).toBeNull();
    expect(reconnected.scope).toBe(OTHER_SCOPE);
  });

  it('drops an in-flight announcement when the scope changes', () => {
    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'day', 1);
    expect(playing.active).not.toBeNull();

    const switched = observe(playing, 'night', 1, OTHER_SCOPE);
    expect(switched.active).toBeNull();
  });

  it('mints one announcement per transition even if the phase flips back', () => {
    let state = observe(initialPhaseTransitionState, 'night', 1);
    state = observe(state, 'day', 1);
    const dayId = state.active?.id;

    // A late/out-of-order night observation would restart the night banner.
    state = observe(state, 'night', 2);
    expect(state.active?.key).toBe('night');
    expect(state.active?.id).not.toBe(dayId);
  });
});

describe('Phase transitions — dismissal', () => {
  it('clears the announcement when its own id is dismissed', () => {
    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'day', 1);
    const id = playing.active?.id ?? 0;

    const dismissed = phaseTransitionReducer(playing, { type: 'dismissed', id });
    expect(dismissed.active).toBeNull();
  });

  it('ignores a stale dismissal aimed at a previous announcement', () => {
    let state = observe(initialPhaseTransitionState, 'night', 1);
    const staleId = state.active?.id ?? 0;

    state = observe(state, 'day', 1);
    const before = state;

    // An old timer fires late; it must not blank the current banner.
    const after = phaseTransitionReducer(before, { type: 'dismissed', id: staleId });
    expect(after).toBe(before);
    expect(after.active?.key).toBe('day');
  });

  it('reports a duration for the active announcement only', () => {
    const idle = initialPhaseTransitionState;
    expect(announcementDurationMs(idle)).toBe(0);

    const playing = observe(observe(initialPhaseTransitionState, 'night', 1), 'day', 1);
    expect(announcementDurationMs(playing)).toBe(PHASE_ANNOUNCEMENT_MS.day);
    expect(announcementDurationMs(playing)).toBeGreaterThan(
      PHASE_ANNOUNCEMENT_STAGES.entranceMs + PHASE_ANNOUNCEMENT_STAGES.exitMs,
    );
  });
});

describe('Phase transitions — announced phase set', () => {
  it('announces the three active phases only', () => {
    expect(isAnnouncedPhase('night')).toBe(true);
    expect(isAnnouncedPhase('day')).toBe(true);
    expect(isAnnouncedPhase('voting')).toBe(true);
    expect(isAnnouncedPhase('lobby')).toBe(false);
    expect(isAnnouncedPhase('gameover')).toBe(false);
  });

  it('gives every announced phase a duration', () => {
    for (const duration of Object.values(PHASE_ANNOUNCEMENT_MS)) {
      expect(duration).toBeGreaterThan(800);
    }
  });
});