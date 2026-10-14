import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  envDir: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
