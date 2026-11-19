import { defineConfig } from 'vitest/config';

// Unit tests only (no database). End-to-end tests use vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
