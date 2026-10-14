import { describe, expect, it } from 'vitest';

import { roomSurface } from '@/lib/game/safe-room';

/**
 * `roomSurface` is what the room page renders from, so these assertions are a
 * real lock on the gating rather than a restatement of it.
 */

describe('roomSurface', () => {
  it('shows the lobby only before the game starts', () => {
    expect(roomSurface('lobby')).toBe('lobby');
    expect(roomSurface(undefined)).toBe('lobby');
  });

  it('shows the play layout only while the game is running', () => {
    expect(roomSurface('in_progress')).toBe('playing');
  });

  it('shows the game-over surface once the room is finished', () => {
    expect(roomSurface('finished')).toBe('gameOver');
  });

  it('never reports "playing" for a finished room', () => {
    // The defect: the play layout was gated on `!isLobby`, which `finished`
    // satisfies, so a terminated game rendered the live board underneath the
    // game-over panel and read as "the game never ended".
    expect(roomSurface('finished')).not.toBe('playing');
  });

  it('is exclusive: no status maps to two surfaces at once', () => {
    const statuses = ['lobby', 'in_progress', 'finished', undefined];
    for (const status of statuses) {
      const s = roomSurface(status);
      const flags = [s === 'lobby', s === 'playing', s === 'gameOver'];
      expect(flags.filter(Boolean)).toHaveLength(1);
    }
  });

  it('falls back to the lobby for an unrecognised status rather than guessing mid-game', () => {
    // An unknown status must not be treated as "playing", which would offer
    // gameplay actions the server has no phase to accept.
    expect(roomSurface('some_future_status')).toBe('lobby');
  });
});