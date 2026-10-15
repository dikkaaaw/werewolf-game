import { z } from 'zod';

import { SETTINGS } from '@/lib/game/settings';

/**
 * Request schemas. These are the outermost boundary: anything that reaches a
 * handler has already passed one of these.
 *
 * Note what is deliberately ABSENT from every schema: `userId`, `playerId`,
 * `isAlive`, `roleKey`, `phase`, `roundNumber`. The client never states who it
 * is or what the world looks like — that all comes from the verified session
 * and the database.
 */

const controlCharacters = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Display names are rendered next to other players and echoed back into the UI.
 * Strip control characters and reject angle brackets/HTML rather than trying to
 * escape them at render time.
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(SETTINGS.displayName.minLength, 'Name is too short.')
  .max(SETTINGS.displayName.maxLength, 'Name is too long.')
  .refine((value) => !controlCharacters.test(value), {
    message: 'Name contains invalid characters.',
  })
  .refine((value) => !/[<>]/.test(value), {
    message: 'Name cannot contain < or >.',
  });

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  // Exactly the length the database generator produces (SETTINGS.roster).
  // The DB constraint is looser (4-12) on purpose; the API is stricter.
  .regex(
    new RegExp(`^[A-Z0-9]{${SETTINGS.roster.roomCodeLength}}$`),
    `Room codes are ${SETTINGS.roster.roomCodeLength} characters of letters and numbers.`,
  )
  .transform((value) => value.toUpperCase());

export const uuidSchema = z.uuid('Must be a valid UUID.');

export const createRoomSchema = z.object({
  displayName: displayNameSchema,
  maxPlayers: z
    .number()
    .int()
    .min(2)
    .max(SETTINGS.roster.dbMaxPlayersPerRoom)
    .default(SETTINGS.roster.maxPlayersPerRoom),
});

export const joinRoomSchema = z.object({
  roomCode: roomCodeSchema,
  displayName: displayNameSchema,
});

/**
 * Role configuration submitted by the host.
 *
 * The shape is permissive on purpose — `validateRoleConfig` is the module that
 * knows the real rules. This schema only guarantees it is structurally sound,
 * so we can return precise, field-level errors instead of a blanket 400.
 */
export const roleConfigEntrySchema = z.object({
  roleKey: z.string().min(1).max(40),
  roleCount: z.number().int().min(0).max(SETTINGS.roster.maxPlayersPerRoom),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const setRoleConfigSchema = z.object({
  roles: z.array(roleConfigEntrySchema).min(1).max(20),
});

export const submitActionSchema = z.object({
  actionType: z.enum(['eliminate', 'investigate', 'protect']),
  targetPlayerId: uuidSchema,
});

export const castVoteSchema = z.object({
  targetPlayerId: uuidSchema,
});

export const leaveRoomSchema = z.object({}).optional().default({});

/**
 * One phase duration.
 *
 * The bounds here are the widest of the per-phase limits (day allows 600s,
 * night and voting 300s) so a single schema can accept any phase. The
 * per-phase bound is enforced by `validatePhaseSeconds` in room-settings.ts,
 * which reports a field-level error instead of a blanket 400.
 */
export const phaseDurationOverrideSchema = z
  .number()
  .int()
  .min(SETTINGS.phaseSecondsBounds.night.min)
  .max(SETTINGS.phaseSecondsBounds.day.max);

export const phaseSecondsSchema = z
  .object({
    night: phaseDurationOverrideSchema.optional(),
    day: phaseDurationOverrideSchema.optional(),
    voting: phaseDurationOverrideSchema.optional(),
  })
  .strict();

/**
 * POST /api/rooms/:roomId/settings.
 *
 * Both halves are optional so the host can adjust durations without restating
 * roles and vice versa. Validation of the actual values (bounds, counts summing
 * to the roster, at least one Werewolf) happens in `validatePhaseSeconds` /
 * `validateRoleConfig`, which produce field-level issues.
 */
export const updateRoomSettingsSchema = z
  .object({
    phaseSeconds: phaseSecondsSchema.optional(),
    roles: z.array(roleConfigEntrySchema).min(1).max(20).optional(),
  })
  .strict()
  .refine((data) => data.phaseSeconds !== undefined || data.roles !== undefined, {
    message: 'Provide phaseSeconds, roles, or both.',
  });

export const toggleReadySchema = z.object({
  ready: z.boolean().optional(),
  isReady: z.boolean().optional(),
}).refine(
  (data) => typeof data.ready === 'boolean' || typeof data.isReady === 'boolean',
  { message: 'Must provide either isReady or ready boolean' },
).transform((data) => ({
  isReady: (data.isReady ?? data.ready) as boolean,
}));

export const startGameSchema = z.object({
  roles: z.array(roleConfigEntrySchema).min(1).max(20).optional(),
  nightSeconds: phaseDurationOverrideSchema.optional(),
});

/**
 * Room-level host settings, as stored in `rooms.settings`.
 *
 * `phaseSeconds` is written by `POST /api/rooms/:roomId/settings` (via the
 * `set_room_settings` RPC) and read by `phase-advancement` so a host-chosen
 * duration survives across phase transitions instead of reverting to the
 * SETTINGS default.
 *
 * `revealRoleOnElimination` is consumed by `src/lib/game/reveal.ts`. Nothing
 * writes it yet; it defaults to true.
 *
 * `voteTieRule` was REMOVED for the MVP: the tie-break had no supported
 * configuration path (no settings writer, and `resolveVote` was always called
 * with the literal 'none'), so it was an accepted-but-ignored knob. A tie in the
 * MVP simply eliminates nobody. See GAME-RULES.md §8.
 */
export const roomSettingsSchema = z
  .object({
    phaseSeconds: z
      .object({
        night: phaseDurationOverrideSchema.optional(),
        day: phaseDurationOverrideSchema.optional(),
        voting: phaseDurationOverrideSchema.optional(),
      })
      .strict()
      .optional(),
    revealRoleOnElimination: z.boolean().optional(),
  })
  .strict();

export const eventsQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SETTINGS.events.maxPageSize)
    .default(SETTINGS.events.defaultPageSize),
});

export const chatMessageSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty.')
    .max(SETTINGS.chat.maxMessageLength, 'Message is too long.')
    .refine((value) => !controlCharacters.test(value), {
      message: 'Message contains invalid characters.',
    }),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type SubmitActionInput = z.infer<typeof submitActionSchema>;
export type CastVoteInput = z.infer<typeof castVoteSchema>;
export type RoomSettingsInput = z.infer<typeof roomSettingsSchema>;
export type UpdateRoomSettingsInput = z.infer<typeof updateRoomSettingsSchema>;
