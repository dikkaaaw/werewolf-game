import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  envDir: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration and HTTP E2E suites share one isolated Supabase-compatible
    // database and the same rate-limit tables. Running files in parallel makes
    // them contend for room codes, seeded users and rate-limit buckets, so the
    // database suites must execute serially.
    fileParallelism: false,
    // Integration tests need a live Postgres and skip themselves without one.
    // A skipped test is reported as skipped, never as passed.
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/game/**/*.ts', 'src/lib/schemas/**/*.ts', 'src/lib/env.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
