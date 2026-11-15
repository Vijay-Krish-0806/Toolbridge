import { defineConfig } from 'vitest/config';

// Lets `pnpm exec vitest` at the root run every package's tests in one process (watch mode).
// CI runs tests per package through Turborepo instead.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
