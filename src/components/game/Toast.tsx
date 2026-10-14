"use client";

import { useEffect, useReducer, useSyncExternalStore } from 'react';

import {
  initialToastState,
  toastReducer,
  type Toast as ToastData,
  type ToastKind,
} from '@/lib/game/toast';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

const LOOK = {
  success: {
    surface: 'bg-[#0f1a12]/97 border-emerald-400/45',
    accent: 'text-emerald-300',
    icon: '✓',
    ring: 'shadow-[0_14px_40px_-14px_rgba(2,12,8,0.95)]',
    label: 'Success',
  },
  error: {
    surface: 'bg-[#1c0f12]/97 border-rose-400/45',
    accent: 'text-rose-300',
    icon: '!',
    ring: 'shadow-[0_14px_40px_-14px_rgba(20,2,8,0.95)]',
    label: 'Error',
  },
} as const satisfies Record<ToastKind, Record<string, string>>;

export interface ToastApi {
  /** The toast currently on screen, or null. */
  toast: ToastData | null;
  notifySuccess: (title: string, description?: string) => void;
  notifyError: (title: string, description?: string) => void;
  dismiss: () => void;
}

export function useToasts(): ToastApi {
  const [state, dispatch] = useReducer(toastReducer, initialToastState);
  const current = state.current;

  // Auto-dismiss. Success toasts expire; error toasts have a null duration and
  // stay until dismissed. The cleanup clears the timer when the toast changes
  // or the component unmounts, and the id tag stops a stale timer from
  // dismissing a newer toast.
  const toastId = current?.id ?? null;
  const autoDismissMs = current?.autoDismissMs ?? null;

  useEffect(() => {
    if (toastId === null || autoDismissMs === null) return;
    const timer = window.setTimeout(
      () => dispatch({ type: 'expired', id: toastId }),
      autoDismissMs,
    );
    return () => window.clearTimeout(timer);
  }, [toastId, autoDismissMs]);

  return {
    toast: current,
    notifySuccess: (title, description) =>
      dispatch({ type: 'notify', kind: 'success', title, description }),
    notifyError: (title, description) =>
      dispatch({ type: 'notify', kind: 'error', title, description }),
    dismiss: () => dispatch({ type: 'dismiss' }),
  };
}

export interface ToastViewportProps {
  toast: ToastData;
  onDismiss: () => void;
}

/**
 * Single-slot toast.
 *
 * Out of the document flow: `fixed` positioned and sibling to the page content,
 * so showing one never adds height and never pushes the roster down. Safe-area
 * insets are honoured and the max-width keeps it clear of roster rows on small
 * screens.
 *
 * The positioning layer is `pointer-events-none`; only the toast body is
 * `pointer-events-auto`, so the surface a player might be about to tap stays
 * fully clickable everywhere except directly under the toast itself.
 */
export function ToastViewport({ toast, onDismiss }: ToastViewportProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const look = LOOK[toast.kind];

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 [padding-top:max(0.75rem,env(safe-area-inset-top))]"
      role="region"
      aria-label="Notifications"
    >
      {/* Keyed on the toast id so a replacement remounts and replays. */}
      <div
        key={toast.id}
        data-testid="toast"
        data-toast-kind={toast.kind}
        style={
          prefersReducedMotion
            ? undefined
            : { animation: 'toastIn 260ms cubic-bezier(0.22, 1, 0.36, 1)' }
        }
        className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 backdrop-blur-sm ${look.surface} ${look.ring}`}
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[11px] font-bold ${look.accent}`}
        >
          {look.icon}
        </span>

        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-bold leading-snug ${look.accent}`}>{toast.title}</p>
          {toast.description && (
            <p className="mt-0.5 text-[11px] leading-snug text-slate-300">
              {toast.description}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${look.label.toLowerCase()} notification`}
          className="shrink-0 rounded-md border border-slate-600/70 px-1.5 py-0.5 text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-200 motion-reduce:transition-none"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}