/**
 * Toast notification model.
 *
 * Pure state, no React and no DOM, so the "replace, don't stack" and
 * "stale timer cannot dismiss a newer toast" rules are unit-testable in the
 * Node-based Vitest environment.
 *
 * Why toasts exist here: the room page used to render success feedback as an
 * inline banner in the document flow. Every night action or vote pushed the
 * roster further down the page, which is exactly the scrolling this project has
 * been trying to remove. Toasts are positioned out of flow, so they cost the
 * layout nothing.
 */

export type ToastKind = 'success' | 'error';

/** Success is transient. Errors stay until the player dismisses them. */
export const TOAST_SUCCESS_MS = 3000;
export const TOAST_ERROR_MS = null;

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Milliseconds until auto-dismiss; `null` means the toast is sticky. */
  autoDismissMs: number | null;
}

export interface ToastState {
  current: Toast | null;
  sequence: number;
}

export const initialToastState: ToastState = {
  current: null,
  sequence: 0,
};

export type ToastAction =
  | { type: 'notify'; kind: ToastKind; title: string; description?: string }
  /** Explicit dismissal (close button). */
  | { type: 'dismiss' }
  /** Timer-driven dismissal, tagged with the id it was scheduled for. */
  | { type: 'expired'; id: number }
  | { type: 'clear' };

/** Auto-dismiss delay for a kind, or `null` for sticky toasts. */
export function autoDismissMsFor(kind: ToastKind): number | null {
  return kind === 'success' ? TOAST_SUCCESS_MS : TOAST_ERROR_MS;
}

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'notify': {
      // A new notification replaces the current one. Repeatedly re-targeting
      // must never accumulate a stack of banners.
      const id = state.sequence + 1;
      return {
        sequence: id,
        current: {
          id,
          kind: action.kind,
          title: action.title,
          description: action.description,
          autoDismissMs: autoDismissMsFor(action.kind),
        },
      };
    }

    case 'dismiss':
    case 'clear':
      return state.current === null ? state : { ...state, current: null };

    case 'expired': {
      // Stale-timer guard: a timer scheduled for toast #1 must not blank the
      // toast that replaced it as #2.
      if (!state.current || state.current.id !== action.id) return state;
      return { ...state, current: null };
    }

    default:
      return state;
  }
}

/** Stable React key so a replacement toast remounts and replays its animation. */
export function toastKey(toast: Toast | null): string | null {
  return toast === null ? null : `toast-${toast.id}`;
}