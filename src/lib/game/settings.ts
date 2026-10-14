/**
 * Every tunable in the game, in one place.
 *
 * These are deliberately NOT environment variables: they are part of the rules
 * and therefore versioned, reviewable and unit-tested. Env vars are for
 * deployment secrets only (see src/lib/env.ts).
 *
 * Changing a value here changes documented behaviour — update
 * docs/RESOURCE-LIMITS.md alongside it.
 */

export const SETTINGS = {
    roster: {
        maxPlayersPerRoom: 20,
        /**
         * NOTE: there is deliberately no roster.minPlayersPerRoom. An earlier
         * duplicate of that constant was never read by anything, and two copies of
         * a rules threshold can silently drift apart. `gameplay.minStartablePlayers`
         * is the single application-side minimum; the database enforces the same
         * value independently in migration 0008. This minimum gates *starting a
         * game* only — a lobby with four players can always accept a fifth.
         */
        /** Hard ceiling enforced by the DB check constraint as well. */
        dbMaxPlayersPerRoom: 20,
        roomCodeLength: 6,
        /** 31 symbols: no I/O/0/1 to survive being read aloud or retyped. */
        roomCodeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    },

    phaseSeconds: {
        night: 10,
        day: 10,
        voting: 10,
    },

    /** Bounds a room's custom phase durations are validated against. */
    phaseSecondsBounds: {
        night: { min: 15, max: 300 },
        day: { min: 15, max: 600 },
        voting: { min: 15, max: 300 },
    },

    /**
     * Max acceptable body size for game endpoints (PRD §18.F).
     * Checked before JSON parsing so a huge body never reaches the parser.
     */
    maxRequestBodyBytes: 16 * 1024,

    displayName: {
        minLength: 2,
        maxLength: 24,
    },

    chat: {
        maxMessageLength: 500,
    },

    events: {
        defaultPageSize: 50,
        maxPageSize: 200,
    },

    /** PRD §18.D retention windows. Applied by the cleanup job. */
    retention: {
        lobbyIdleExpiryHours: 2,
        finishedRoomHours: 24,
        rateLimitCounterHours: 1,
        auditLogDays: 7,
        /** Rows deleted per cleanup run — never an unbounded DELETE. */
        cleanupBatchSize: 50,
    },

    /**
     * PRD §18.B rate limits, enforced in Postgres so they hold across every
     * serverless instance (see docs/RESOURCE-LIMITS.md §2).
     */
    rateLimits: {
        createRoom: { limit: 3, windowSeconds: 3600 },
        joinRoom: { limit: 10, windowSeconds: 60 },
        submitAction: { limit: 10, windowSeconds: 60 },
        submitVote: { limit: 10, windowSeconds: 60 },
        roomSnapshot: { limit: 60, windowSeconds: 60 },
        /**
         * Reading your own secret. The game page fetches this alongside every
         * snapshot poll (the in-game client heartbeats every 4s = 15/min), so the
         * budget matches `roomSnapshot` rather than the tighter mutation budgets.
         */
        myRole: { limit: 60, windowSeconds: 60 },
    },

    concurrency: {
        /**
         * How long a phase-transition claim is honoured before another worker may
         * steal it. Must exceed the worst-case resolution time with margin.
         * See docs/IMPLEMENTATION-PLAN.md "Concurrency & scheduling design".
         */
        transitionClaimTimeoutSeconds: 30,
    },

    gameplay: {
        /**
         * NOTE: `defaultVoteTieRule` was removed. Nothing read it, and the MVP has
         * no host setting for vote ties — a tie eliminates nobody. See
         * GAME-RULES.md §8.
         */
        /**
         * Standard party-game behaviour: an eliminated player's role is revealed
         * immediately. Set false for a hidden-role variant.
         */
        defaultRevealRoleOnElimination: true,
        /**
         * Minimum players before the engine refuses to start a game. Five is the
         * smallest roster that gives every information role (Seer, Doctor) a
         * partner and leaves the single Werewolf at least two Villagers to hide
         * among. Enforced in three places that must agree: this constant, the
         * `start` route, and `start_game` in migration 0008.
         */
        minStartablePlayers: 5,
    },
} as const

export type Settings = typeof SETTINGS

/** Helper: whole seconds → Postgres interval literal. */
export function secondsToInterval(seconds: number): string {
    if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new RangeError(`secondsToInterval expects a positive integer, got ${seconds}`)
    }
    return `${seconds} seconds`
}
