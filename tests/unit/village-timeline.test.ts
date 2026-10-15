import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VillageTimeline } from '@/components/game/VillageTimeline';
import { PHASE_THEMES } from '@/lib/game/phase-theme';
import type { SafeEvent } from '@/lib/game/safe-room';

describe('VillageTimeline component', () => {
  it('renders an empty state when no events are recorded', () => {
    const html = renderToStaticMarkup(
      createElement(VillageTimeline, {
        theme: PHASE_THEMES.day,
        events: [],
      }),
    );
    expect(html).toContain('Village Chronicle');
    expect(html).toContain('Belum ada catatan peristiwa di desa ini.');
  });

  it('renders formatted narratives for all game events', () => {
    const events: SafeEvent[] = [
      {
        id: 1,
        eventType: 'game_started',
        publicPayload: { playerCount: 5, roundNumber: 1 },
        roundNumber: 1,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        eventType: 'night_started',
        publicPayload: { roundNumber: 1 },
        roundNumber: 1,
        createdAt: '2026-01-01T00:01:00Z',
      },
      {
        id: 3,
        eventType: 'day_started',
        publicPayload: { roundNumber: 1 },
        roundNumber: 1,
        createdAt: '2026-01-01T00:02:00Z',
      },
      {
        id: 4,
        eventType: 'player_eliminated',
        publicPayload: { playerId: 'p-1', displayName: 'Budi' },
        roundNumber: 1,
        createdAt: '2026-01-01T00:02:01Z',
      },
      {
        id: 5,
        eventType: 'voting_started',
        publicPayload: { roundNumber: 1 },
        roundNumber: 1,
        createdAt: '2026-01-01T00:03:00Z',
      },
      {
        id: 6,
        eventType: 'game_finished',
        publicPayload: { winner: 'werewolf' },
        roundNumber: 1,
        createdAt: '2026-01-01T00:04:00Z',
      },
    ];

    const html = renderToStaticMarkup(
      createElement(VillageTimeline, {
        theme: PHASE_THEMES.night,
        events,
      }),
    );

    expect(html).toContain('Permainan Dimulai');
    expect(html).toContain('Malam ke-1');
    expect(html).toContain('Pagi Hari ke-1');
    expect(html).toContain('Budi Telah Gugur!');
    expect(html).toContain('Musyawarah Voting');
    expect(html).toContain('Permainan Berakhir!');
    expect(html).toContain('Tim Serigala 🐺');
    expect(html).toContain('6 Catatan');
  });
});
