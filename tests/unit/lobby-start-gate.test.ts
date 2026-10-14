import { describe, expect, it } from 'vitest';
import { canStartLobbyGame } from '@/lib/game/safe-room';
import { SETTINGS } from '@/lib/game/settings';

const ready = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ isReady: true, id: `p${i + 1}` }));

const MIN = SETTINGS.gameplay.minStartablePlayers;

describe('canStartLobbyGame — lobby Start-button gate', () => {
  // The threshold is read from SETTINGS so this suite cannot drift from the
  // value the start route and the start_game RPC enforce.
  it('uses the same minimum as the authoritative rules (5)', () => {
    expect(MIN).toBe(5);
  });

  it('refuses a four-player lobby', () => {
    // This is the boundary that regressed: the room page previously used a
    // hardcoded `>= 4`, which enabled the Start button that the server then
    // rejected with "Need at least 5 players".
    expect(canStartLobbyGame(ready(4), MIN)).toBe(false);
  });

  it('refuses an empty lobby', () => {
    expect(canStartLobbyGame([], MIN)).toBe(false);
  });

  it('allows exactly five ready players', () => {
    expect(canStartLobbyGame(ready(5), MIN)).toBe(true);
  });

  it('allows a larger roster', () => {
    expect(canStartLobbyGame(ready(9), MIN)).toBe(true);
  });

  it('refuses a five-player lobby when any player is not ready', () => {
    const players = ready(5).map((p, i) => (i === 3 ? { ...p, isReady: false } : p));
    expect(canStartLobbyGame(players, MIN)).toBe(false);
  });

  it('refuses a larger roster when any player is not ready', () => {
    const players = ready(8).map((p, i) => (i === 7 ? { ...p, isReady: false } : p));
    expect(canStartLobbyGame(players, MIN)).toBe(false);
  });
});