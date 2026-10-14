"use client";

import { useState, type ReactNode } from 'react';

import { PhaseAmbience } from '@/components/game/PhaseAmbience';
import type { PhaseTheme } from '@/lib/game/phase-theme';

/**
 * Themed page shell with a cross-fading backdrop.
 *
 * Two stacked layers are always present: the outgoing theme sits underneath at
 * full opacity, and the incoming theme fades up over it. Swapping the theme
 * therefore reads as the environment *gradually* dimming or brightening rather
 * than snapping, without remounting a single piece of gameplay UI.
 *
 * `children` is passed straight through and is never keyed or remounted by a
 * phase change — that is what keeps the Secret Role Card stable.
 */
export interface PhaseShellProps {
  theme: PhaseTheme;
  children?: ReactNode;
  /**
   * `wide` is the lobby (unchanged). `game` is active gameplay: wider than the
   * old `max-w-2xl` so the roster can lay out in multiple columns and show more
   * players and actions without scrolling. `default` stays narrow for the
   * loading and error frames.
   */
  width?: 'default' | 'wide' | 'game' | 'gameWide';
}

const WIDTH = {
  default: 'max-w-2xl',
  wide: 'max-w-4xl',
  game: 'max-w-5xl',
  // Three-column play layout: role card | roster | room chat.
  gameWide: 'max-w-7xl',
} as const;

export function PhaseShell({ theme, children, width = 'default' }: PhaseShellProps) {
  // `previous` is exactly one phase behind `current`, so the backdrop never
  // accumulates stale layers. Adjusting state during render (rather than in an
  // effect) keeps the cross-fade in the same commit as the theme change.
  const [previous, setPrevious] = useState(theme);
  const [current, setCurrent] = useState(theme);

  if (current.key !== theme.key) {
    setPrevious(current);
    setCurrent(theme);
  }

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden">
      {/* Outgoing layer — static, always fully opaque underneath. */}
      <div
        key={`base-${previous.key}`}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 ${previous.page}`}
      >
        <PhaseAmbience themeKey={previous.key} />
      </div>

      {/* Incoming layer — remounts on phase change and fades up over it. */}
      <div
        key={`fade-${current.key}`}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 motion-safe:animate-[phaseBackdropIn_900ms_cubic-bezier(0.4,0,0.2,1)_both] ${current.page}`}
      >
        <PhaseAmbience themeKey={current.key} />
      </div>

      {/* Readability scrim: keeps text contrast stable over the gradients. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 ${current.isLight ? 'bg-white/25' : 'bg-black/25'}`}
      />

      <div
        className={`relative mx-auto w-full ${WIDTH[width]} px-4 py-5 sm:px-6 sm:py-7 ${current.text}`}
      >
        {children}
      </div>
    </div>
  );
}