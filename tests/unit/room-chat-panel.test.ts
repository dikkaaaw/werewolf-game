import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RoomChatPanel } from '@/components/game/RoomChatPanel';
import { PHASE_THEMES } from '@/lib/game/phase-theme';
import type { SafeRoom } from '@/lib/game/safe-room';

const room = {
  id: 'room-1',
  roomCode: 'ABC234',
  status: 'in_progress',
  phase: 'day',
  roundNumber: 1,
  maxPlayers: 8,
  currentPlayers: 5,
  hostUserId: 'host-1',
  expiresAt: null,
  stateVersion: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  players: [
    { id: 'p1', userId: 'u1', displayName: 'Alice', seatNumber: 1, isAlive: true },
    { id: 'p2', userId: 'u2', displayName: 'Bob', seatNumber: 2, isAlive: true },
  ],
} as unknown as SafeRoom;

function render(props: Partial<Parameters<typeof RoomChatPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(RoomChatPanel, {
      theme: PHASE_THEMES.day,
      room,
      isSelfAlive: true,
      isNight: false,
      ...props,
    }),
  );
}

describe('RoomChatPanel (prepared right-hand column)', () => {
  it('renders the reserved chat column labelled for assistive tech', () => {
    const html = render();
    expect(html).toContain('aria-label="Room chat"');
    expect(html).toContain('Room Chat');
  });

  it('is explicitly marked as not yet active, so it cannot look broken', () => {
    const html = render();
    expect(html).toContain('Coming soon');
    expect(html).toContain('Message box is not active yet.');
  });

  it('does not render an active composer or any network control', () => {
    const html = render();
    // No text input, textarea or send button: this column is scaffold only.
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Send');
  });

  it('explains that dead players cannot chat', () => {
    const html = render({ isSelfAlive: false });
    expect(html).toContain('Eliminated players cannot use room chat.');
  });

  it('explains that chat is closed during the night', () => {
    const html = render({ isNight: true });
    expect(html).toContain('Chat opens during the day.');
  });

  it('shows the room player count as context', () => {
    const html = render();
    expect(html).toContain('Players in this room: 2');
  });

  it('uses the supplied theme tokens so it matches the phase', () => {
    const html = render();
    // day theme accent is applied via the shared token set
    expect(html).toContain(PHASE_THEMES.day.surface);
  });
});