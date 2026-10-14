"use client";

import type { PhaseThemeKey } from '@/lib/game/phase-theme';

/**
 * Decorative atmospheric layers for the active phase.
 *
 * Purely presentational: every layer is `aria-hidden` and `pointer-events-none`,
 * so nothing here can intercept a click or reach a screen reader. All motion is
 * CSS keyframe driven (see globals.css) and is disabled by the
 * `prefers-reduced-motion` block, so no JS animation loop is ever started.
 */
export interface PhaseAmbienceProps {
  themeKey: PhaseThemeKey;
}

const STARFIELD =
  'bg-[radial-gradient(1.5px_1.5px_at_12%_18%,rgba(226,232,255,0.85),transparent),radial-gradient(1.5px_1.5px_at_28%_62%,rgba(226,232,255,0.7),transparent),radial-gradient(1.5px_1.5px_at_44%_12%,rgba(226,232,255,0.8),transparent),radial-gradient(1.5px_1.5px_at_61%_44%,rgba(199,210,254,0.7),transparent),radial-gradient(1.5px_1.5px_at_73%_26%,rgba(226,232,255,0.75),transparent),radial-gradient(1.5px_1.5px_at_86%_58%,rgba(199,210,254,0.6),transparent),radial-gradient(1.5px_1.5px_at_92%_14%,rgba(226,232,255,0.8),transparent),radial-gradient(1.5px_1.5px_at_34%_86%,rgba(226,232,255,0.55),transparent),radial-gradient(1.5px_1.5px_at(56%_78%,rgba(199,210,254,0.6),transparent)]';

export function PhaseAmbience({ themeKey }: PhaseAmbienceProps) {
  return (
    <>
      {themeKey === 'night' && (
        <>
          {/* Slow moonlight sweeping across the sky */}
          <div
            className="absolute -top-1/4 -left-1/4 h-[70vh] w-[70vh] rounded-full bg-[radial-gradient(circle,rgba(165,180,252,0.16),transparent_65%)] motion-safe:animate-[phaseMoonSweep_18s_ease-in-out_infinite]"
          />
          {/* Drifting starfield */}
          <div
            className={`absolute inset-0 ${STARFIELD} motion-safe:animate-[phaseStarDrift_60s_linear_infinite]`}
          />
          {/* Restrained atmospheric bloom along the horizon */}
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgba(76,29,149,0.18),transparent)]" />
        </>
      )}

      {themeKey === 'day' && (
        <>
          {/* Sunrise bloom expanding from below the horizon */}
          <div className="absolute inset-x-0 bottom-0 h-[75vh] bg-[radial-gradient(60rem_34rem_at_50%_115%,rgba(251,191,36,0.5),transparent_70%)] motion-safe:animate-[phaseSunrise_1.4s_cubic-bezier(0.22,1,0.36,1)_both]" />
          {/* Warm haze drifting across the upper sky */}
          <div className="absolute inset-x-0 top-0 h-1/2 bg-[linear-gradient(to_bottom,rgba(253,230,138,0.28),transparent)]" />
        </>
      )}

      {themeKey === 'voting' && (
        <>
          {/* Cool daylight wash */}
          <div className="absolute -top-1/3 left-1/2 h-[80vh] w-[80vh] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.20),transparent_62%)]" />
          {/* Faint ballot-paper ruling, a quiet nod to the act of voting */}
          <div className="absolute inset-0 opacity-[0.10] bg-[repeating-linear-gradient(to_bottom,transparent,transparent_38px,rgba(30,64,175,0.5)_38px,rgba(30,64,175,0.5)_39px)]" />
        </>
      )}

      {themeKey === 'gameover' && (
        <div className="absolute -top-1/3 left-1/2 h-[85vh] w-[85vh] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.14),transparent_65%)]" />
      )}

      {themeKey === 'lobby' && (
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(45rem_22rem_at_50%_100%,rgba(251,191,36,0.14),transparent_70%)]" />
      )}
    </>
  );
}