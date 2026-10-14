import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Environment validation is the last line of defence against the two
 * credential mistakes that would be catastrophic here:
 *
 *   1. the SECRET key pasted into a NEXT_PUBLIC_ variable  -> shipped to every
 *      browser, bypassing every RLS policy;
 *   2. the PUBLISHABLE key pasted into SUPABASE_SERVICE_ROLE_KEY -> every
 *      server-side "privileged" read silently returns nothing.
 */

const VALID_URL = 'https://abcdefghijklmnop.supabase.co';
const PUBLISHABLE = `sb_publishable_${'a'.repeat(32)}`;
const SECRET = `sb_secret_${'b'.repeat(32)}`;
const LEGACY_JWT = `${'c'.repeat(20)}.${'d'.repeat(20)}.${'e'.repeat(20)}`;

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: VALID_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE,
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
  SCHEDULER_SECRET: 'f'.repeat(64),
};

async function loadEnv() {
  vi.resetModules();
  return import('@/lib/env');
}

describe('env validation', () => {
  const original = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NEXT_PUBLIC_') || key === 'SUPABASE_SERVICE_ROLE_KEY' || key === 'SCHEDULER_SECRET') {
        delete process.env[key];
      }
    }
    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('accepts a valid modern publishable + secret pair', async () => {
    const { publicEnv, serverEnv } = await loadEnv();

    expect(publicEnv().NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(PUBLISHABLE);
    expect(serverEnv().SUPABASE_SERVICE_ROLE_KEY).toBe(SECRET);
  });

  it('accepts a legacy JWT service-role key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_JWT;
    const { serverEnv } = await loadEnv();

    expect(serverEnv().SUPABASE_SERVICE_ROLE_KEY).toBe(LEGACY_JWT);
  });

  it('REFUSES the secret key in the client-safe slot', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SECRET;
    const { publicEnv } = await loadEnv();

    expect(() => publicEnv()).toThrow(/PUBLISHABLE\/anon key, not the secret key/);
  });

  it('REFUSES the publishable key as the service-role key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = PUBLISHABLE;
    const { serverEnv } = await loadEnv();

    expect(() => serverEnv()).toThrow(/not the publishable key/);
  });

  it('refuses a non-https Supabase URL (except localhost)', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://insecure.example.com';
    const { publicEnv } = await loadEnv();

    expect(() => publicEnv()).toThrow(/must use https/);
  });

  it('allows http for local development', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    const { publicEnv } = await loadEnv();

    expect(publicEnv().NEXT_PUBLIC_SUPABASE_URL).toBe('http://localhost:54321');
  });

  it('refuses a short or empty scheduler secret', async () => {
    process.env.SCHEDULER_SECRET = 'tooshort';
    const { serverEnv } = await loadEnv();

    expect(() => serverEnv()).toThrow(/at least 32 characters/);
  });

  it('reports every problem at once rather than one at a time', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { publicEnv } = await loadEnv();

    let message = '';
    try {
      publicEnv();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(message).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('caches after the first successful read', async () => {
    const { publicEnv } = await loadEnv();
    const first = publicEnv();

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(publicEnv()).toBe(first);
  });
});

describe('secretsMatch', () => {
  it('accepts identical secrets', async () => {
    const { secretsMatch } = await loadEnv();
    expect(secretsMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects different secrets and length mismatches', async () => {
    const { secretsMatch } = await loadEnv();
    expect(secretsMatch('abc123', 'abc124')).toBe(false);
    expect(secretsMatch('abc123', 'abc1234')).toBe(false);
    expect(secretsMatch('', 'x')).toBe(false);
  });
});
