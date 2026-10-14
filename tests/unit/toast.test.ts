import { describe, expect, it } from 'vitest';

import {
  TOAST_ERROR_MS,
  TOAST_SUCCESS_MS,
  autoDismissMsFor,
  initialToastState,
  toastKey,
  toastReducer,
  type ToastAction,
  type ToastState,
} from '@/lib/game/toast';

function reduce(state: ToastState, ...actions: ToastAction[]): ToastState {
  return actions.reduce(toastReducer, state);
}

describe('Toast — creation and replacement', () => {
  it('starts with nothing on screen', () => {
    expect(initialToastState.current).toBeNull();
    expect(initialToastState.sequence).toBe(0);
    expect(toastKey(initialToastState.current)).toBeNull();
  });

  it('shows a single toast with its title and description', () => {
    const state = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'Protection submitted',
      description: 'Target: TestBot 4',
    });

    expect(state.current).not.toBeNull();
    expect(state.current?.title).toBe('Protection submitted');
    expect(state.current?.description).toBe('Target: TestBot 4');
    expect(state.current?.kind).toBe('success');
  });

  it('replaces rather than stacks when the target changes repeatedly', () => {
    // Re-targeting was the case that used to pile up inline banners.
    let state = initialToastState;
    for (let i = 0; i < 6; i += 1) {
      state = toastReducer(state, {
        type: 'notify',
        kind: 'success',
        title: 'Protection submitted',
        description: `Target: Bot ${i}`,
      });
    }

    // Single slot, latest copy, and a fresh id each time.
    expect(state.current?.description).toBe('Target: Bot 5');
    expect(state.sequence).toBe(6);
  });

  it('issues a fresh id per toast so the animation replays', () => {
    const first = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'a',
    });
    const second = toastReducer(first, { type: 'notify', kind: 'success', title: 'b' });

    expect(second.current?.id).not.toBe(first.current?.id);
    expect(toastKey(second.current)).not.toBe(toastKey(first.current));
  });
});

describe('Toast — dismissal', () => {
  it('dismisses on request', () => {
    const shown = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'Vote submitted',
    });
    expect(toastReducer(shown, { type: 'dismiss' }).current).toBeNull();
  });

  it('is a no-op when nothing is showing', () => {
    expect(toastReducer(initialToastState, { type: 'dismiss' })).toBe(initialToastState);
    expect(toastReducer(initialToastState, { type: 'clear' })).toBe(initialToastState);
  });

  it('expires when its own timer fires', () => {
    const shown = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'Vote submitted',
    });
    const id = shown.current?.id ?? 0;

    expect(toastReducer(shown, { type: 'expired', id }).current).toBeNull();
  });

  it('ignores a stale timer aimed at a replaced toast', () => {
    // The regression this guards: toast #1's 3s timer must not blank toast #2.
    const first = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'Protection submitted',
      description: 'Target: Bot 1',
    });
    const staleId = first.current?.id ?? 0;

    const second = toastReducer(first, {
      type: 'notify',
      kind: 'success',
      title: 'Protection submitted',
      description: 'Target: Bot 2',
    });

    const after = toastReducer(second, { type: 'expired', id: staleId });
    expect(after).toBe(second);
    expect(after.current?.description).toBe('Target: Bot 2');
  });
});

describe('Toast — timing', () => {
  it('auto-dismisses success after about three seconds', () => {
    expect(autoDismissMsFor('success')).toBe(TOAST_SUCCESS_MS);
    expect(TOAST_SUCCESS_MS).toBeGreaterThanOrEqual(2500);
    expect(TOAST_SUCCESS_MS).toBeLessThanOrEqual(3500);
  });

  it('keeps errors on screen until dismissed', () => {
    // Errors must never vanish unread.
    expect(autoDismissMsFor('error')).toBeNull();
    expect(TOAST_ERROR_MS).toBeNull();

    const shown = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'error',
      title: 'Action rejected',
    });

    // The null duration is the contract: `useToasts` only schedules an expiry
    // timer when `autoDismissMs` is a number, so an error is never sent an
    // `expired` event and can only leave via an explicit dismiss.
    expect(shown.current?.autoDismissMs).toBeNull();
    expect(shown.current?.kind).toBe('error');

    // It still leaves when the player dismisses it.
    expect(toastReducer(shown, { type: 'dismiss' }).current).toBeNull();
  });
});

describe('Toast — reduced content contract', () => {
  it('allows a toast with no description', () => {
    const state = toastReducer(initialToastState, {
      type: 'notify',
      kind: 'success',
      title: 'Ready',
    });
    expect(state.current?.description).toBeUndefined();
  });

  it('keeps the newest of several interleaved notifications', () => {
    const state = reduce(
      initialToastState,
      { type: 'notify', kind: 'success', title: 'first' },
      { type: 'notify', kind: 'error', title: 'rejected' },
      { type: 'notify', kind: 'success', title: 'third' },
    );

    expect(state.current?.title).toBe('third');
    expect(state.current?.kind).toBe('success');
  });
});