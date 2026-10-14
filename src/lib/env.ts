import { z } from 'zod';

/**
 * Server-only environment access.
 *
 * Two separate schemas on purpose:
 *
 *  - `publicEnvSchema`   — safe to ship to the browser. Only `NEXT_PUBLIC_*`.
 *  - `serverEnvSchema`   — everything else, including the service-role key.
 *
 * `serverEnv()` is never called at module scope so that importing this file from
 * a component cannot throw at build time just because a secret is absent; it
 * throws on first server use instead, where the error is actionable.
 */

const supabaseUrlSchema = z
  .url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL')
  .refine((value) => value.startsWith('https://') || value.startsWith('http://localhost'), {
    message: 'NEXT_PUBLIC_SUPABASE_URL must use https (http is allowed only for localhost)',
  });

const supabasePublishableKeySchema = z
  .string()
  .min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short')
  // New Supabase projects issue `sb_publishable_...`; older ones a long JWT.
  // Accept both, but explicitly reject the SECRET key here. Pasting the
  // service-role key into a NEXT_PUBLIC_ variable is the single most damaging
  // mistake possible in this project: it would ship to the browser and bypass
  // every RLS policy. Failing loudly here is the only place it can be caught.
  .refine(
    (value) => !value.startsWith('sb_secret_'),
    'NEXT_PUBLIC_SUPABASE_ANON_KEY must be the PUBLISHABLE/anon key, not the secret key. ' +
      'A value starting with sb_secret_ here would be exposed to every browser.',
  );

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlSchema,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabasePublishableKeySchema,
});

const serviceRoleKeySchema = z
  .string()
  .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short')
  // The modern non-JWT `sb_secret_...` key, or the legacy three-part JWT
  // service-role key. Reject the publishable key so the two can never be
  // swapped: with only the publishable key every RLS-protected read would
  // return nothing and the failure would look like a data bug.
  .refine(
    (value) => value.startsWith('sb_secret_') || value.split('.').length === 3,
    'SUPABASE_SERVICE_ROLE_KEY must be the secret/service-role key, not the publishable key',
  )
  .refine(
    (value) => !value.startsWith('sb_publishable_'),
    'SUPABASE_SERVICE_ROLE_KEY must be the secret/service-role key, not the publishable key',
  );

export const serverEnvSchema = publicEnvSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKeySchema,
  SCHEDULER_SECRET: z
    .string()
    .min(32, 'SCHEDULER_SECRET must be at least 32 characters; generate with `openssl rand -hex 32`'),
  DATABASE_URL: z.url().optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedPublicEnv: PublicEnv | undefined;
let cachedServerEnv: ServerEnv | undefined;

/** Validate and return the browser-safe subset. Safe to call from shared code. */
export function publicEnv(): PublicEnv {
  if (!cachedPublicEnv) {
    const parsed = publicEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });

    if (!parsed.success) {
      throw new Error(
        `Invalid public environment configuration:\n${formatIssues(parsed.error)}\n` +
          'Copy .env.example to .env.local and fill it in.',
      );
    }
    cachedPublicEnv = parsed.data;
  }
  return cachedPublicEnv;
}

/** Validate and return server-only config, including the service-role key. */
export function serverEnv(): ServerEnv {
  if (!cachedServerEnv) {
    const parsed = serverEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SCHEDULER_SECRET: process.env.SCHEDULER_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
    });

    if (!parsed.success) {
      throw new Error(`Invalid server environment configuration:\n${formatIssues(parsed.error)}`);
    }
    cachedServerEnv = parsed.data;
  }
  return cachedServerEnv;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Constant-time-ish comparison for the scheduler secret.
 *
 * A plain `===` on a secret leaks its prefix through response timing. This is
 * not a silver bullet, but it is free and removes the obvious weakness.
 */
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
