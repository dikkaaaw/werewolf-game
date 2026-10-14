import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PhaseAnnouncementLiveRegion,
  PhaseAnnouncementOverlay,
} from '@/components/game/PhaseAnnouncement';
import {
  PHASE_ANNOUNCEMENT_MS,
  PHASE_ANNOUNCEMENT_STAGES,
  PHASE_ANNOUNCEMENT_TOTAL_MS,
  initialPhaseTransitionState,
  phaseTransitionReducer,
} from '@/lib/game/phase-transition';
import type { PhaseAnnouncement } from '@/lib/game/phase-transition';

const NIGHT: PhaseAnnouncement = {
  id: 1,
  key: 'night',
  headline: 'Night Falls',
  subline: 'The village sleeps. Make your choice.',
  glyph: '🌙',
  roundNumber: 2,
};

describe('PhaseAnnouncement rendering', () => {
  it('shows the headline, subline, and round for the active phase', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    expect(html).toContain('Night Falls');
    expect(html).toContain('The village sleeps. Make your choice.');
    expect(html).toContain('Round 2');
  });

  it('never intercepts pointer events over the roster', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // BOTH the wrapper and the banner itself must be inert. Relying on the
    // ancestor alone is what let a click land on the banner instead of a row.
    expect(html.match(/pointer-events-none/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-hidden="true"');
  });

  it('carries no backdrop-filter, which could capture hit-testing', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // A full-screen backdrop-filter is promoted to its own compositing layer
    // and can swallow clicks even under pointer-events:none.
    expect(html).not.toContain('backdrop-blur');
  });

  it('is centred in the viewport by a fixed flex wrapper, not by offsets', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    expect(html).toContain('fixed inset-0');
    expect(html).toContain('flex items-center justify-center');
    // No absolute positioning or percentage margins to fight with.
    expect(html).not.toContain('absolute inset-0');
    expect(html).not.toContain('-translate-x-1/2');
    expect(html).not.toContain('top-1/2');
    expect(html).not.toContain('left-1/2');
  });

  it('pads top and bottom identically so flex centring stays true', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // Asymmetric padding shifts the centred content box.
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('env(safe-area-inset-bottom)');
    // `pb-6` competed with the arbitrary padding-bottom property.
    expect(html).not.toMatch(/\bpb-\d/);
    expect(html).not.toMatch(/\bpt-\d/);
  });

  it('respects mobile safe areas and wraps long text', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('break-words');
    expect(html).toContain('max-w-sm');
    expect(html).toContain('min-w-0');
  });

  it('animates around the centred position instead of translating off it', () => {
    const globals = readFileSync(
      fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
      'utf8',
    );
    const keyframes = globals.slice(
      globals.indexOf('@keyframes phaseAnnouncementIn'),
      globals.indexOf('@keyframes phaseAnnouncementIn') + 700,
    );

    // The bug: flexbox already centres the banner, so a percentage translate
    // shifted it half its own width left and half its height up.
    expect(keyframes).not.toContain('-50%');
    expect(keyframes).toContain('translateY(');
  });

  it('runs the full cinematic sequence, not a quick fade', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // 900 entrance + 2600 hold + 800 exit = 4300ms.
    expect(html).toContain(`animation:phaseAnnouncementIn ${PHASE_ANNOUNCEMENT_TOTAL_MS}ms`);
    expect(PHASE_ANNOUNCEMENT_TOTAL_MS).toBe(4300);
  });

  it('fills backwards so a finished animation cannot leave an invisible banner', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // `both` pinned the banner to the 100% stop, which is opacity:0. Any render
    // that did not remount left a full-screen wrapper showing nothing.
    expect(html).toContain('backwards');
    expect(html).not.toContain('both');
  });

  it('staggers entrance, hold and exit within the requested timings', () => {
    const { entranceMs, holdMs, exitMs } = PHASE_ANNOUNCEMENT_STAGES;

    expect(entranceMs).toBeGreaterThanOrEqual(800);
    expect(entranceMs).toBeLessThanOrEqual(1000);
    expect(holdMs).toBeGreaterThanOrEqual(2500);
    expect(holdMs).toBeLessThanOrEqual(3000);
    expect(exitMs).toBeGreaterThanOrEqual(700);
    expect(exitMs).toBeLessThanOrEqual(900);
    expect(PHASE_ANNOUNCEMENT_TOTAL_MS).toBeGreaterThanOrEqual(4000);
    expect(PHASE_ANNOUNCEMENT_TOTAL_MS).toBeLessThanOrEqual(5000);
  });

  it('uses an identical duration for every announced phase', () => {
    const durations = new Set(Object.values(PHASE_ANNOUNCEMENT_MS));
    expect(durations.size).toBe(1);
    expect(PHASE_ANNOUNCEMENT_MS.night).toBe(PHASE_ANNOUNCEMENT_TOTAL_MS);
    expect(PHASE_ANNOUNCEMENT_MS.day).toBe(PHASE_ANNOUNCEMENT_TOTAL_MS);
    expect(PHASE_ANNOUNCEMENT_MS.voting).toBe(PHASE_ANNOUNCEMENT_TOTAL_MS);
  });

  it('keeps the CSS keyframe stops in step with the TypeScript timings', () => {
    const globals = readFileSync(
      fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
      'utf8',
    );
    const block = globals.slice(
      globals.indexOf('@keyframes phaseAnnouncementIn'),
      globals.indexOf('@keyframes phaseAnnouncementIn') + 1200,
    );
    const stops = [...block.matchAll(/([\d.]+)%\s*\{/g)].map((m) => Number(m[1]));

    const { entranceMs, holdMs } = PHASE_ANNOUNCEMENT_STAGES;
    const total = PHASE_ANNOUNCEMENT_TOTAL_MS;
    expect(stops[0]).toBe(0);
    expect(stops[1]).toBeCloseTo((entranceMs / total) * 100, 1);
    expect(stops[2]).toBeCloseTo(((entranceMs + holdMs) / total) * 100, 1);
    expect(stops[3]).toBe(100);
  });

  it('never translates by a percentage of its own size', () => {
    const globals = readFileSync(
      fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
      'utf8',
    );
    const block = globals.slice(
      globals.indexOf('@keyframes phaseAnnouncementIn'),
      globals.indexOf('@keyframes phaseAnnouncementIn') + 1200,
    );

    // translate(-50%, …) is for absolutely positioned elements. The banner is
    // flex-centred, so a percentage translate shifts it off-centre.
    expect(block).not.toMatch(/translate\(-?\d+%/);
    expect(block).toContain('translateY(');
  });

  it('omits the round line when the round is zero', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, {
        announcement: { ...NIGHT, roundNumber: 0 },
      }),
    );

    expect(html).not.toContain('Round 0');
  });

  it('uses a near-opaque surface so copy reads over the animated backdrop', () => {
    const htmlFor = (key: PhaseAnnouncement['key']) =>
      renderToStaticMarkup(
        createElement(PhaseAnnouncementOverlay, { announcement: { ...NIGHT, key } }),
      );

    // 40-60% translucent fills let the starfield/daylight gradient show through
    // the title and made it hard to read. Each surface is now solid.
    for (const key of ['night', 'day', 'voting'] as const) {
      const html = htmlFor(key);
      // The plate must not be a translucent palette colour.
      expect(html, key).toMatch(/bg-\[#[0-9a-f]{6}\]/);
    }

    expect(htmlFor('night')).toContain('bg-[#0b0f24]');
    expect(htmlFor('day')).toContain('bg-[#fdf3da]');
    expect(htmlFor('voting')).toContain('bg-[#eef4ff]');
  });

  it('keeps a readable plate on both dark and light backdrops', () => {
    const night = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );
    // Night plate is near-black, so the title must be near-white.
    expect(night).toContain('text-indigo-50');

    const day = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, {
        announcement: { ...NIGHT, key: 'day' },
      }),
    );
    // Day plate is near-white, so the title must be near-black.
    expect(day).toContain('text-[#3b2a06]');

    const voting = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, {
        announcement: { ...NIGHT, key: 'voting' },
      }),
    );
    expect(voting).toContain('text-[#0b2545]');
  });

  it('separates the plate from the backdrop with a border, ring and shadow', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    expect(html).toContain('border-indigo-400/50');
    expect(html).toContain('ring-1');
    expect(html).toContain('shadow-[0_18px_50px_-12px_rgba(2,6,23,0.9)]');
  });

  it('keeps each phase visually distinct after the contrast fix', () => {
    const surfaces = (['night', 'day', 'voting'] as const).map(
      (key) =>
        renderToStaticMarkup(
          createElement(PhaseAnnouncementOverlay, { announcement: { ...NIGHT, key } }),
        ).match(/bg-\[#[0-9a-f]{6}\]/)?.[0],
    );

    expect(new Set(surfaces).size).toBe(3);
  });

  it('gives each announced phase its own accent treatment', () => {
    const htmlFor = (key: PhaseAnnouncement['key']) =>
      renderToStaticMarkup(
        createElement(PhaseAnnouncementOverlay, { announcement: { ...NIGHT, key } }),
      );

    expect(htmlFor('night')).toContain('text-indigo-50');
    expect(htmlFor('day')).toContain('text-[#3b2a06]');
    expect(htmlFor('voting')).toContain('text-[#0b2545]');
  });
});

describe('PhaseAnnouncementLiveRegion', () => {
  it('announces the headline politely to assistive tech', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementLiveRegion, { announcement: NIGHT }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Night Falls. Round 2.');
  });

  it('renders nothing audible when there is no announcement', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementLiveRegion, { announcement: undefined as never }),
    );

    expect(html).toContain('role="status"');
    expect(html).not.toContain('Round');
  });
});

describe('Announcement wiring through the reducer', () => {
  it('identifies the banner so each announcement can remount and replay', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: NIGHT }),
    );

    // CSS animations only run on mount. Without a key per announcement id, the
    // second banner inherited the finished animation's fill state and was
    // rendered at opacity 0.
    expect(html).toContain('data-testid="phase-announcement-banner"');
    expect(html).toContain('data-announcement="night"');
  });

  it('renders a banner only after a genuine phase change', () => {
    const loaded = phaseTransitionReducer(initialPhaseTransitionState, {
      type: 'observed',
      scope: 's',
      key: 'night',
      roundNumber: 1,
    });
    expect(loaded.active).toBeNull();

    const transitioned = phaseTransitionReducer(loaded, {
      type: 'observed',
      scope: 's',
      key: 'day',
      roundNumber: 1,
    });
    expect(transitioned.active).not.toBeNull();

    const html = renderToStaticMarkup(
      createElement(PhaseAnnouncementOverlay, { announcement: transitioned.active! }),
    );
    expect(html).toContain('Daybreak');
  });
});