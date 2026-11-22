/**
 * Kept as a test because it guards money and data: a write tool (such as a refund) must never be
 * retried automatically, or one request could refund twice; and an oversized result must be cut
 * with a visible note, because Ollama silently drops a message that does not fit the context.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { hashArguments, type ToolAuditor, WriteAlreadyStartedError } from './audit.js';
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

/**
 * Step 4.2: the executor is the last line of defense, so these cases call it directly, the way
 * a buggy agent or another caller (MCP server, platform API) would: no menu, no selector.
 */
describe('ToolExecutor with an authorizer', () => {
  const authorizer = {
    authorize: (principal: { role: string }, toolName: string) =>
      principal.role === 'owner' || toolName === 'get_thing'
        ? ({ allowed: true } as const)
        : ({
            allowed: false,
            reason: `Role "${principal.role}" may not use "${toolName}".`,
          } as const),
  };

  /** An executor with the authorizer over one read and one write tool that count their runs. */
  function guarded() {
    const read = flakyTool('get_thing', 'read', 0, serverError);
    const write = flakyTool('refund_thing', 'write', 0, serverError);
    const executor = new ToolExecutor(new ToolRegistry([read.tool, write.tool]), { authorizer });
    return { executor, read, write };
  }

  it('blocks a forbidden call before it runs, even with valid arguments', async () => {
    const { executor, write } = guarded();
    const result = await executor.run(call('refund_thing', '{"id":"a"}'), {
      principal: { userId: 'u1', role: 'warehouse' },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Role "warehouse" may not use "refund_thing".',
        retryable: false,
      },
    });
    expect(write.calls()).toBe(0);
  });

  it('fails closed: no principal means no call at all', async () => {
    const { executor, read } = guarded();
    const result = await executor.run(call('get_thing', '{"id":"a"}'));
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(read.calls()).toBe(0);
  });

  it('refuses a forbidden call before checking its arguments or name', async () => {
    const { executor } = guarded();
    const principal = { userId: 'u1', role: 'warehouse' };
    // Bad JSON and an unknown name are answered as forbidden: nothing is revealed about them.
    for (const c of [call('refund_thing', 'not json'), call('no_such_tool', '{}')]) {
      expect(await executor.run(c, { principal })).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
  });

  it('runs an allowed call normally', async () => {
    const { executor, write } = guarded();
    const result = await executor.run(call('refund_thing', '{"id":"a"}'), {
      principal: { userId: 'u1', role: 'owner' },
    });
    expect(result.ok).toBe(true);
    expect(write.calls()).toBe(1);
  });
});

/**
 * Step 4.10 (money safety): with an auditor, a write runs only after its write-ahead record is
 * saved. If the audit log is down, the refund must not happen at all.
 */
describe('ToolExecutor with an auditor', () => {
  /** An auditor that records what it was told; `failStarted` makes the write-ahead fail. */
  function recordingAuditor(failStarted = false) {
    const events: string[] = [];
    const auditor: ToolAuditor = {
      started: (c) => {
        events.push(`started ${c.toolName}`);
        return failStarted ? Promise.reject(new Error('db down')) : Promise.resolve();
      },
      finished: (c, outcome) => {
        events.push(`finished ${c.toolName} ${outcome.status} ${c.argsHash}`);
        return Promise.resolve();
      },
    };
    return { auditor, events };
  }
  const hash = hashArguments('{"id":"a"}');

  it('records a write before it runs, then its outcome', async () => {
    const write = flakyTool('refund_thing', 'write', 0, serverError);
    const { auditor, events } = recordingAuditor();
    const executor = new ToolExecutor(new ToolRegistry([write.tool]), { audit: auditor });
    expect(await executor.run(call('refund_thing', '{"id":"a"}'))).toMatchObject({ ok: true });
    expect(events).toEqual(['started refund_thing', `finished refund_thing ok ${hash}`]);
    expect(write.calls()).toBe(1);
  });

  it('does not run a write whose write-ahead record fails (fail closed)', async () => {
    const write = flakyTool('refund_thing', 'write', 0, serverError);
    const { auditor, events } = recordingAuditor(true);
    const executor = new ToolExecutor(new ToolRegistry([write.tool]), { audit: auditor });
    const result = await executor.run(call('refund_thing', '{"id":"a"}'));
    expect(result).toMatchObject({ ok: false, error: { code: 'audit_unavailable' } });
    expect(write.calls()).toBe(0);
    expect(events.at(-1)).toBe(`finished refund_thing audit_unavailable ${hash}`);
  });

  it('never runs a write again that already started once (a retried run)', async () => {
    const write = flakyTool('refund_thing', 'write', 0, serverError);
    const auditor: ToolAuditor = {
      started: () => Promise.reject(new WriteAlreadyStartedError('started before')),
      finished: () => Promise.resolve(),
    };
    const executor = new ToolExecutor(new ToolRegistry([write.tool]), { audit: auditor });
    const result = await executor.run(call('refund_thing', '{"id":"a"}'));
    expect(result).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
    expect(write.calls()).toBe(0);
  });

  it('records reads and refused calls once, after the fact', async () => {
    const read = flakyTool('get_thing', 'read', 0, serverError);
    const { auditor, events } = recordingAuditor(true); // a failing write-ahead does not matter
    const executor = new ToolExecutor(new ToolRegistry([read.tool]), { audit: auditor });
    await executor.run(call('get_thing', '{"id":"a"}'));
    await executor.run(call('made_up', '{"id":"a"}'));
    expect(events).toEqual([
      `finished get_thing ok ${hash}`,
      `finished made_up unknown_tool ${hash}`,
    ]);
  });
});
