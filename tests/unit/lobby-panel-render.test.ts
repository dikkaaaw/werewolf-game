import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LobbyPanel } from '@/components/game/LobbyPanel';
import { PhaseShell } from '@/components/game/PhaseShell';
import { GameOverPanel } from '@/components/game/GameOverPanel';
import { resolveGameOverPresentation, PHASE_THEMES } from '@/lib/game/phase-theme';
import type { SafeRoom } from '@/lib/game/safe-room';

const room: SafeRoom = {
  id: 'room-1',
  roomCode: 'ABC234',
  status: 'lobby',
  phase: 'lobby',
  roundNumber: 0,
  phaseEndsAt: null,
  maxPlayers: 20,
  currentPlayers: 2,
  hostUserId: 'user-1',
  expiresAt: null,
  stateVersion: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  players: [
    {
      id: 'p1',
      userId: 'user-1',
      displayName: 'Alice',
      seatNumber: 1,
      isAlive: true,
      isReady: true,
      deathCause: null,
      diedAt: null,
      joinedAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      revealedRole: null,
    },
    {
      id: 'p2',
      userId: 'user-2',
      displayName: 'Bob',
      seatNumber: 2,
      isAlive: true,
      isReady: false,
      deathCause: null,
      diedAt: null,
      joinedAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      revealedRole: null,
    },
  ],
};

function renderLobby(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(LobbyPanel, {
      theme: PHASE_THEMES.lobby,
      room,
      isHost: true,
      isSelfReady: true,
      canStart: false,
      copied: false,
      busyKey: null,
      currentUserId: 'user-1',
      onCopyCode: vi.fn(),
      onToggleReady: vi.fn(),
      onStartGame: vi.fn(),
      onDevAddBots: vi.fn(),
      ...overrides,
    }),
  );
}

describe('LobbyPanel rendering', () => {
  it('renders the room code prominently with a copy control', () => {
    const html = renderLobby();

    expect(html).toContain('ABC234');
    expect(html).toContain('Copy room code ABC234');
    expect(html).toContain('Copy');
  });

  it('renders capacity as an accessible progressbar', () => {
    const html = renderLobby();

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="20"');
    expect(html).toContain('aria-valuenow="2"');
    // Two players in a five-player game: three more needed.
    expect(html).toContain('3 more needed to start (min 5)');
  });

  it('renders one scannable card per player with ready state and seat', () => {
    const html = renderLobby();

    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('Ready');
    expect(html).toContain('Not ready');
    expect(html).toContain('Seat 1');
    expect(html).toContain('Seat 2');
    expect(html).toContain('1/2 ready');
  });

  it('marks the caller and the host distinctly', () => {
    const html = renderLobby();

    expect(html).toContain('>You<');
    expect(html).toContain('>Host<');
  });

  it('gives the host a primary start control and non-hosts a waiting state', () => {
    const hostHtml = renderLobby({ canStart: true });
    expect(hostHtml).toContain('▶ Start Game');

    const guestHtml = renderLobby({ isHost: false });
    expect(guestHtml).toContain('Waiting for the host to start');
    expect(guestHtml).not.toContain('▶ Start Game');
  });

  it('exposes the ready toggle with pressed state', () => {
    expect(renderLobby({ isSelfReady: true })).toContain('aria-pressed="true"');
    expect(renderLobby({ isSelfReady: false })).toContain('aria-pressed="false"');
  });

  it('hides the dev harness outside development', () => {
    expect(renderLobby()).not.toContain('Dev harness');
  });
});

describe('PhaseShell rendering', () => {
  it('applies the resolved theme page and ambience', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.night }, 'body'),
    );

    expect(html).toContain('from-[#080b1c]');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('body');
  });

  it('renders a base layer plus a cross-fading layer for the active phase', () => {
    const html = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.night }, 'body'),
    );

    // Two stacked backdrops: the static base and the fading incoming layer.
    // `key` is a React-only prop, so assert on the resulting structure instead.
    const pageLayer = 'pointer-events-none absolute inset-0';
    expect(html.split(pageLayer).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain('phaseBackdropIn_900ms');
    // Night ambience: moonlight sweep and drifting starfield.
    expect(html).toContain('phaseMoonSweep_18s');
    expect(html).toContain('phaseStarDrift_60s');
  });

  it('gives each phase its own decorative ambience', () => {
    const ambienceFor = (themeKey: 'lobby' | 'night' | 'day' | 'voting' | 'gameover') =>
      renderToStaticMarkup(
        createElement(PhaseShell, { theme: PHASE_THEMES[themeKey] }, 'x'),
      );

    expect(ambienceFor('night')).toContain('phaseMoonSweep_18s');
    expect(ambienceFor('day')).toContain('phaseSunrise');
    expect(ambienceFor('voting')).toContain('rgba(30,64,175,0.5)');
  });

  it('uses a wider container for the lobby than for gameplay', () => {
    const wide = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.lobby, width: 'wide' }, 'x'),
    );
    const narrow = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.lobby, width: 'default' }, 'x'),
    );

    expect(wide).toContain('max-w-4xl');
    expect(narrow).toContain('max-w-2xl');
  });

  it('gives active gameplay more width than the lobby default', () => {
    // Gameplay needs the horizontal room for a multi-column roster; the lobby
    // layout is unchanged.
    const game = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.night, width: 'game' }, 'x'),
    );
    const lobby = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.lobby, width: 'wide' }, 'x'),
    );
    const narrow = renderToStaticMarkup(
      createElement(PhaseShell, { theme: PHASE_THEMES.night, width: 'default' }, 'x'),
    );

    expect(game).toContain('max-w-5xl');
    expect(lobby).toContain('max-w-4xl');
    expect(narrow).toContain('max-w-2xl');
  });
});

describe('GameOverPanel rendering', () => {
  it('renders the village victory presentation', () => {
    const html = renderToStaticMarkup(
      createElement(GameOverPanel, {
        presentation: resolveGameOverPresentation('village'),
        room: { ...room, status: 'finished', phase: 'finished', roundNumber: 3 },
        ownRole: null,
      }),
    );

    expect(html).toContain('The Village Wins');
    expect(html).toContain('text-emerald-300');
    expect(html).toContain('Round 3');
  });

  it('renders the werewolf victory presentation', () => {
    const html = renderToStaticMarkup(
      createElement(GameOverPanel, {
        presentation: resolveGameOverPresentation('werewolf'),
        room: { ...room, status: 'finished', phase: 'finished' },
        ownRole: null,
      }),
    );

    expect(html).toContain('The Pack Wins');
    expect(html).toContain('text-rose-300');
  });
});