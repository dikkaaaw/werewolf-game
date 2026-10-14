/**
 * Which entry action the landing form should enable.
 *
 * The create and join forms deliberately share one display-name field, so with
 * both a name and a room code filled in, both buttons used to be live at once
 * and a player who meant to JOIN could create a room by accident. Filling a
 * room code is the join intent, so it turns Create off; Join stays off until
 * the code is complete, because a partial code cannot match a room.
 *
 * Pure and dependency-free so the rule can be pinned by unit tests.
 */

export const ROOM_CODE_LENGTH = 6;

export interface RoomEntryAvailability {
  /** The host action: needs a display name, and no room code typed. */
  canCreate: boolean;
  /** The join action: needs a display name and a complete room code. */
  canJoin: boolean;
}

export function roomEntryAvailability(
  displayName: string,
  roomCode: string,
  busy: boolean,
): RoomEntryAvailability {
  const hasName = displayName.trim().length > 0;
  const code = roomCode.trim().toUpperCase();
  const isJoining = code.length > 0;

  return {
    // Mutually exclusive: a typed room code means the player is joining, never hosting.
    canCreate: !busy && hasName && !isJoining,
    canJoin: !busy && hasName && code.length === ROOM_CODE_LENGTH,
  };
}