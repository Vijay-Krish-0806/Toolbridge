/**
 * Kept as a test because it guards money and data: a write tool (such as a refund) must never be
 * retried automatically, or one request could refund twice; and an oversized result must be cut
 * with a visible note, because Ollama silently drops a message that does not fit the context.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolExecutionError } from './errors.js';
import { type RetryEvent, ToolExecutor, truncateResult } from './executor.js';
import { ToolRegistry } from './registry.js';
import { type SafetyClass, type Tool, defineTool } from './tool.js';

/**
 * Builds a fake tool that fails with `failure` for the first `failTimes` calls, then succeeds.
 * `calls()` reports how many times it actually ran.
 */
function flakyTool(name: string, safety: SafetyClass, failTimes: number, failure: Error) {
  let count = 0;
  const tool = defineTool({
    name,
    description: 'test tool',
    safety,
    input: z.object({ id: z.string() }),
    execute: ({ id }) => {
      count++;
      return count <= failTimes ? Promise.reject(failure) : Promise.resolve({ id, ok: true });
    },
  });
  return { tool, calls: () => count };
}

const serverError = new ToolExecutionError('http_error', 'HTTP 503', {
  retryable: true,
  status: 503,
});

/** Builds an executor around `tools` that never really waits, and records each retry. */
function executorFor(...tools: Tool[]) {
  const retries: RetryEvent[] = [];
  const executor = new ToolExecutor(new ToolRegistry(tools), {
    timeoutMs: 50,
    sleep: () => Promise.resolve(),
    onRetry: (event) => retries.push(event),
  });
  return { executor, retries };
}

const call = (name: string, args: string) => ({ id: 'call_1', name, arguments: args });

describe('ToolExecutor', () => {
  it('retries a read tool on a retryable error, then succeeds', async () => {
    const flaky = flakyTool('get_thing', 'read', 2, serverError);
    const { executor, retries } = executorFor(flaky.tool);

    const result = await executor.run(call('get_thing', '{"id":"a"}'));

    expect(result).toEqual({ ok: true, content: '{"id":"a","ok":true}' });
    expect(flaky.calls()).toBe(3);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('never retries a write tool, even on a retryable error', async () => {
    const refund = flakyTool('request_refund', 'write', 1, serverError);
    const { executor, retries } = executorFor(refund.tool);

    const result = await executor.run(call('request_refund', '{"id":"a"}'));

    expect(result).toMatchObject({ ok: false, error: { code: 'http_error', status: 503 } });
    expect(refund.calls()).toBe(1);
    expect(retries).toEqual([]);
  });

  it('does not retry an error that cannot succeed later (404)', async () => {
    const notFound = new ToolExecutionError('http_error', 'HTTP 404', { status: 404 });
    const missing = flakyTool('get_thing', 'read', 5, notFound);
    const { executor } = executorFor(missing.tool);

    await executor.run(call('get_thing', '{"id":"a"}'));

    expect(missing.calls()).toBe(1);
  });

  it('times out a tool that never answers, even if it ignores the abort signal', async () => {
    const hang = defineTool({
      name: 'hang',
      description: 'never resolves',
      safety: 'write',
      input: z.object({}),
      execute: () => new Promise(() => undefined),
    });
    const { executor } = executorFor(hang);

    const result = await executor.run(call('hang', '{}'));

    expect(result).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } });
  });

  it('returns bad JSON, failed validation and unknown tools as error results', async () => {
    const { executor } = executorFor(flakyTool('get_thing', 'read', 0, serverError).tool);

    expect(await executor.run(call('get_thing', '{"id":'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    expect(await executor.run(call('get_thing', '{"id":42}'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: expect.stringContaining('id') as string },
    });
    expect(await executor.run(call('delete_all', '{}'))).toMatchObject({
      ok: false,
      error: { code: 'unknown_tool', message: expect.stringContaining('get_thing') as string },
    });
  });

  it('cuts an oversized result and says so, leaving small results untouched', async () => {
    const big = defineTool({
      name: 'big',
      description: 'returns a long string',
      safety: 'read',
      input: z.object({}),
      execute: () => Promise.resolve('x'.repeat(50)),
    });
    const executor = new ToolExecutor(new ToolRegistry([big]), { maxResultChars: 20 });

    const result = await executor.run(call('big', '{}'));

    // 50 x's become a 52-character JSON string, cut to the first 20 characters plus a note.
    expect(result).toEqual({
      ok: true,
      content: `"${'x'.repeat(19)}... [truncated: showed 20 of 52 characters. Use filters or a smaller page to see the rest.]`,
    });
    expect(truncateResult('{"ok":true}', 20)).toBe('{"ok":true}');
  });
});
