import { defineConfig } from 'vitest/config';

// End-to-end tests: the real app (compiled to dist/ by tsc) against the Docker MongoDB.
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    setupFiles: ['test/load-env.ts'],
    fileParallelism: false, // test files re-seed the same database, so run them one at a time
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
