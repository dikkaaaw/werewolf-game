import { describe, expect, it } from 'vitest';

import { getPlayerAvatar, getPlayerInitials, orderRoster } from '@/lib/game/player-avatar';

/**
 * The avatar hue is seeded on the player id, never the role, so a colour can
 * never leak a secret. These tests pin that, plus the reading order.
 */

describe('getPlayerInitials', () => {
  it('takes the first and last initial of a multi-word name', () => {
    expect(getPlayerInitials('Andi Pratama')).toBe('AP');
    expect(getPlayerInitials('Maria de la Cruz Santos')).toBe('MS');
  });

  it('takes the first two letters of a single-word name', () => {
    expect(getPlayerInitials('budi')).toBe('BU');
  });

  it('falls back to the seat number when the name is blank', () => {
    expect(getPlayerInitials('   ', 7)).toBe('7');
    expect(getPlayerInitials('', 3)).toBe('3');
    expect(getPlayerInitials('  ', undefined)).toBe('?');
  });

  it('ignores extra whitespace', () => {
    expect(getPlayerInitials('  Andi   Pratama  ')).toBe('AP');
  });
});

describe('getPlayerAvatar', () => {
  it('is stable for the same player', () => {
    const a = getPlayerAvatar('player-1', 'Andi', 1);
    const b = getPlayerAvatar('player-1', 'Andi', 1);
    expect(a).toEqual(b);
  });

  it('depends only on the id, never on the name', () => {
    // Same seat, renamed mid-game: the chip must not jump colour.
    const before = getPlayerAvatar('player-1', 'Andi', 1);
    const after = getPlayerAvatar('player-1', 'Andi Ganti Nama', 1);
    expect(after.textClass).toBe(before.textClass);
    expect(after.surfaceClass).toBe(before.surfaceClass);
  });

  it('spreads distinct players across different hues', () => {
    const hues = new Set(
      Array.from({ length: 40 }, (_, i) => getPlayerAvatar(`player-${i}`, `P${i}`, i).textClass),
    );
    // More than one hue, so players are visually distinguishable.
    expect(hues.size).toBeGreaterThan(1);
  });

  it('always returns a chip even for an unnamed player', () => {
    const avatar = getPlayerAvatar('player-x', '', 4);
    expect(avatar.initials).toBe('4');
    expect(avatar.textClass).toBeTruthy();
  });
});

describe('orderRoster', () => {
  const players = [
    { id: 'a', seatNumber: 1, isAlive: false },
    { id: 'b', seatNumber: 2, isAlive: true },
    { id: 'c', seatNumber: 3, isAlive: true },
    { id: 'd', seatNumber: 4, isAlive: false },
  ];

  it('puts the living first and the fallen last', () => {
    expect(orderRoster(players).map((p) => p.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('keeps seat order inside each group', () => {
    const ordered = orderRoster(players);
    expect(ordered.filter((p) => p.isAlive).map((p) => p.seatNumber)).toEqual([2, 3]);
    expect(ordered.filter((p) => !p.isAlive).map((p) => p.seatNumber)).toEqual([1, 4]);
  });

  it('does not mutate the input', () => {
    const copy = players.slice();
    orderRoster(players);
    expect(players).toEqual(copy);
  });

  it('is stable across repeated calls, so the list never reshuffles mid-debate', () => {
    expect(orderRoster(players)).toEqual(orderRoster(players));
  });

  it('handles an empty roster', () => {
    expect(orderRoster([])).toEqual([]);
  });
});