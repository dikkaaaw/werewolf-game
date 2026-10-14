"use client";

import {
  PHASE_ANNOUNCEMENT_TOTAL_MS,
  type PhaseAnnouncement,
} from '@/lib/game/phase-transition';

export interface PhaseAnnouncementProps {
  announcement: PhaseAnnouncement;
}

/**
 * Per-phase presentation.
 *
 * Readability rule: the surface must be near-opaque. These banners sit over an
 * animated backdrop that is itself bright (day/voting) or busy with a
 * starfield (night), so a 40-60% translucent fill let the backdrop show
 * straight through the copy and made the title hard to read.
 *
 * Each phase keeps its own hue so the identity survives:
 *   night   deep indigo plate, near-white title
 *   day     warm cream plate, near-black amber title
 *   voting  pale blue plate, near-black blue title
 *
 * No `backdrop-filter` anywhere: it is what previously allowed a full-screen
 * overlay to capture hit-testing (see the wrapper note below).
 */
const PRESENTATION = {
  night: {
    text: 'text-indigo-50',
    subline: 'text-indigo-200/85',
    rule: 'bg-indigo-300/80',
    glow: 'shadow-[0_18px_50px_-12px_rgba(2,6,23,0.9)]',
    border: 'border-indigo-400/50',
    surface: 'bg-[#0b0f24]',
    ring: 'ring-1 ring-indigo-300/25',
  },
  day: {
    text: 'text-[#3b2a06]',
    subline: 'text-[#6b4f10]',
    rule: 'bg-[#a16207]',
    glow: 'shadow-[0_18px_50px_-12px_rgba(120,53,15,0.55)]',
    border: 'border-[#d9a441]',
    surface: 'bg-[#fdf3da]',
    ring: 'ring-1 ring-[#b8860b]/35',
  },
  voting: {
    text: 'text-[#0b2545]',
    subline: 'text-[#1e4272]',
    rule: 'bg-[#1d4ed8]',
    glow: 'shadow-[0_18px_50px_-12px_rgba(12,40,90,0.55)]',
    border: 'border-[#5b8def]',
    surface: 'bg-[#eef4ff]',
    ring: 'ring-1 ring-[#2563eb]/35',
  },
} as const;

/**
 * Temporary centered phase announcement.
 *
 * Centring: the wrapper is a viewport-sized fixed box using flex centring, so
 * the banner sits at the true viewport centre. The keyframes therefore animate
 * only around that centred position (translateY + scale) and never translate by
 * a percentage of the element's own size — that double-offset is what pushed
 * the banner off-centre before.
 *
 * Input: the wrapper is `pointer-events-none` and so is the banner inside it.
 * A full-screen `backdrop-filter` is deliberately absent — it promotes the
 * element to its own compositing layer, and Chromium/WebKit can let such a
 * layer capture hit-testing through `pointer-events: none`, which would block
 * the roster for the whole announcement. `fixed` elements are positioned
 * relative to the viewport here because no ancestor applies a transform,
 * filter, or backdrop-filter.
 *
 * Mobile: safe-area insets are respected on top and bottom, and the text is
 * allowed to wrap so a long headline can never overflow a narrow viewport.
 */
export function PhaseAnnouncementOverlay({ announcement }: PhaseAnnouncementProps) {
  const look = PRESENTATION[announcement.key];

  return (
    // Symmetric padding only. An earlier version mixed `pb-6` with a
    // `[padding-bottom:…]` arbitrary property, and which one won depended on
    // stylesheet order rather than the class list. Asymmetric padding shifts
    // the flex centring, so the banner must be padded equally top and bottom.
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center px-4 [padding-top:max(1.5rem,env(safe-area-inset-top))] [padding-bottom:max(1.5rem,env(safe-area-inset-bottom))]"
    >
      {/*
        Keyed on the announcement id. CSS animations only run when an element
        mounts, so without this key a second announcement reused the finished
        animation's `fill-mode: both` end state and rendered completely
        invisible at its final transform.
      */}
      <div
        key={announcement.id}
        style={{
          // `backwards`, not `both`: the animation's 100% stop is fully
          // transparent, and `both` would pin the banner to that invisible
          // state after it finished. With `backwards` the element falls back to
          // its normal CSS — visible and perfectly centred — so any situation
          // where the animation does not replay degrades to a readable banner
          // rather than a blank one.
          animation: `phaseAnnouncementIn ${PHASE_ANNOUNCEMENT_TOTAL_MS}ms linear backwards`,
        }}
        data-testid="phase-announcement-banner"
        data-announcement={announcement.key}
        className={`pointer-events-none w-full max-w-sm min-w-0 rounded-2xl border px-5 py-6 text-center ${look.surface} ${look.border} ${look.ring} ${look.glow}`}
      >
        <p className={`text-3xl leading-none ${look.text}`}>{announcement.glyph}</p>

        <h2
          className={`mt-2.5 break-words font-mono text-xl font-black uppercase leading-tight sm:text-2xl ${look.text}`}
        >
          {announcement.headline}
        </h2>

        <div aria-hidden="true" className={`mx-auto mt-2.5 h-px w-14 ${look.rule}`} />

        <p className={`mt-2.5 break-words text-[11px] leading-snug ${look.subline}`}>
          {announcement.subline}
        </p>

        {announcement.roundNumber > 0 && (
          <p
            className={`mt-2 break-words font-mono text-[10px] font-bold uppercase tracking-[0.3em] ${look.subline}`}
          >
            Round {announcement.roundNumber}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Screen-reader companion to the purely-visual overlay above.
 *
 * Rendering the headline as text here (rather than in the overlay) keeps the
 * announcement in the accessibility tree without exposing the decorative
 * layout to it.
 */
export function PhaseAnnouncementLiveRegion({ announcement }: PhaseAnnouncementProps) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement ? `${announcement.headline}. Round ${announcement.roundNumber}.` : ''}
    </div>
  );
}