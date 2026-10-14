import { describe, expect, it } from 'vitest';

import { roomEntryAvailability, ROOM_CODE_LENGTH } from '@/lib/game/room-entry';

describe('roomEntryAvailability', () => {
  it('enables Create for a display name alone', () => {
    expect(roomEntryAvailability('Detective Holmes', '', false)).toEqual({
      canCreate: true,
      canJoin: false,
    });
  });

  it('keeps Create off once a room code is typed (join intent)', () => {
    // The reported bug: with both a name and a code present, both buttons used
    // to be live and a player intending to join could create a room instead.
    const entry = roomEntryAvailability('Detective Holmes', 'ABC234', false);
    expect(entry.canCreate).toBe(false);
    expect(entry.canJoin).toBe(true);
  });

  it('never enables Create and Join at the same time', () => {
    const names = ['', 'A', 'Detective Holmes'];
    const codes = ['', 'A', 'ABC', 'ABC234', 'ZZZZZZ'];

    for (const name of names) {
      for (const code of codes) {
        for (const busy of [false, true]) {
          const entry = roomEntryAvailability(name, code, busy);
          expect(
            entry.canCreate && entry.canJoin,
            `both enabled for name=${JSON.stringify(name)} code=${JSON.stringify(code)} busy=${busy}`,
          ).toBe(false);
        }
      }
    }
  });

  it('keeps Join off until the code is complete', () => {
    const partial = roomEntryAvailability('Alice', 'ABC', false);
    expect(partial.canJoin).toBe(false);
    // A partial code still signals join intent, so Create stays off.
    expect(partial.canCreate).toBe(false);
  });

  it('ignores surrounding whitespace and case when judging the code', () => {
    const spaced = roomEntryAvailability('Alice', '  abc234  ', false);
    expect(spaced.canJoin).toBe(true);
    expect(spaced.canCreate).toBe(false);
  });

  it('treats a whitespace-only code as no code, so Create stays available', () => {
    const entry = roomEntryAvailability('Alice', '   ', false);
    expect(entry.canCreate).toBe(true);
    expect(entry.canJoin).toBe(false);
  });

  it('requires a display name for either action', () => {
    expect(roomEntryAvailability('', '', false)).toEqual({
      canCreate: false,
      canJoin: false,
    });
    expect(roomEntryAvailability('   ', 'ABC234', false)).toEqual({
      canCreate: false,
      canJoin: false,
    });
  });

  it('disables both actions while a request is in flight', () => {
    expect(roomEntryAvailability('Alice', '', true)).toEqual({
      canCreate: false,
      canJoin: false,
    });
    expect(roomEntryAvailability('Alice', 'ABC234', true)).toEqual({
      canCreate: false,
      canJoin: false,
    });
  });

  it('accepts exactly the documented code length', () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
    const ok = 'A'.repeat(ROOM_CODE_LENGTH);
    const tooLong = 'A'.repeat(ROOM_CODE_LENGTH + 1);
    expect(roomEntryAvailability('Alice', ok, false).canJoin).toBe(true);
    // An over-long code cannot match a room, so it is not a valid join target.
    expect(roomEntryAvailability('Alice', tooLong, false).canJoin).toBe(false);
  });
});