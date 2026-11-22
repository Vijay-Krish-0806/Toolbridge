import { defineConfig } from 'vitest/config';

/**
 * Conformance tests against the Docker MongoDB (CI: the infra job).
 * `globals: true` is required by @langchain/langgraph-checkpoint-validation, which calls
 * `describe`/`beforeAll` as globals (measured: without it, "beforeAll is not defined").
 * The excluded test checks an optional optimisation (store only changed channel values) that
 * LangGraph's own MemorySaver does not do either; see ADR 0030.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    setupFiles: ['test/load-env.ts'],
    globals: true,
    testNamePattern: /^(?!.*should only store channel_values that have changed).*$/,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
