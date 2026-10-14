/**
 * Identity anchor for a player row.
 *
 * A seat number is table metadata ("seat 3"); during discussion people actually
 * track names and faces. An initials chip gives each seat a stable visual
 * identity at a glance.
 *
 * Privacy: the hue is derived from the player id, never from the role or
 * alignment, so a colour cannot leak anyone's secret. The same player keeps
 * the same chip for the whole game.
 */

export interface PlayerAvatar {
  /** 1-2 uppercase letters from the display name. */
  initials: string;
  /** Tailwind text colour class. */
  textClass: string;
  /** Tailwind background/border colour classes. */
  surfaceClass: string;
}

const HUES: ReadonlyArray<{ textClass: string; surfaceClass: string }> = [
  { textClass: 'text-sky-300', surfaceClass: 'bg-sky-500/15 border-sky-500/30' },
  { textClass: 'text-emerald-300', surfaceClass: 'bg-emerald-500/15 border-emerald-500/30' },
  { textClass: 'text-amber-200', surfaceClass: 'bg-amber-500/15 border-amber-500/30' },
  { textClass: 'text-fuchsia-300', surfaceClass: 'bg-fuchsia-500/15 border-fuchsia-500/30' },
  { textClass: 'text-teal-300', surfaceClass: 'bg-teal-500/15 border-teal-500/30' },
  { textClass: 'text-orange-300', surfaceClass: 'bg-orange-500/15 border-orange-500/30' },
  { textClass: 'text-indigo-300', surfaceClass: 'bg-indigo-500/15 border-indigo-500/30' },
  { textClass: 'text-lime-300', surfaceClass: 'bg-lime-500/15 border-lime-500/30' },
];

/** FNV-1a, so the hue is stable across reloads without a random seed. */
function hash(value: string): number {
  let acc = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    acc ^= value.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  return acc;
}

/**
 * Up to two initials from a display name.
 *
 * Falls back to the seat number when the name is empty or all whitespace, so a
 * row is never rendered as a blank chip.
 */
export function getPlayerInitials(displayName: string, seatNumber?: number): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return seatNumber != null ? String(seatNumber) : '?';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * Avatar for a player. Seeded on `playerId` so it never moves between renders
 * and never depends on anything secret.
 */
export function getPlayerAvatar(
  playerId: string,
  displayName: string,
  seatNumber?: number,
): PlayerAvatar {
  const hue = HUES[hash(playerId) % HUES.length];
  return { initials: getPlayerInitials(displayName, seatNumber), ...hue };
}

/**
 * Order the roster for reading: everyone still in play first, then the fallen.
 *
 * Within each group the seat number decides, so the list never reshuffles
 * mid-game — a list that reorders itself is impossible to track while debating.
 */
export function orderRoster<T extends { seatNumber: number; isAlive: boolean }>(
  players: readonly T[],
): T[] {
  return players
    .slice()
    .sort((a, b) => {
      if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
      return a.seatNumber - b.seatNumber;
    });
}