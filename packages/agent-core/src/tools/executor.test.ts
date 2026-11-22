/**
 * Kept as a test because it guards money and data: a write tool (such as a refund) must never be
 * retried automatically, or one request could refund twice; and an oversized result must be cut
 * with a visible note, because Ollama silently drops a message that does not fit the context.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CredentialUnavailableError,
  hashArguments,
  type ToolAuditor,
  WriteAlreadyStartedError,
} from './audit.js';
import { CircuitBreaker } from './circuit-breaker.js';
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

/**
 * Step 4.4c (user delegation): the executor picks each call's credential. A call whose user
 * credential is gone is refused, never run under another identity, and leaves no audit row.
 */
describe('ToolExecutor with credentialFor', () => {
  /** A write tool that records which credential it was given. */
  function credentialTool() {
    const seen: (string | undefined)[] = [];
    const tool = defineTool({
      name: 'refund_thing',
      description: 'test tool',
      safety: 'write',
      input: z.object({ id: z.string() }),
      execute: async (_args, context) => {
        seen.push(await context.auth?.secretFor('bearer', { type: 'http', scheme: 'bearer' }));
        return { ok: true };
      },
    });
    return { tool, seen };
  }
  const token = (value: string) => ({ secretFor: () => Promise.resolve(value) });

  it('passes the chosen credential to the tool', async () => {
    const { tool, seen } = credentialTool();
    const executor = new ToolExecutor(new ToolRegistry([tool]), {
      credentialFor: (c) => Promise.resolve(token(`user-token-for-${c.id}`)),
    });
    await executor.run(call('refund_thing', '{"id":"a"}'));
    expect(seen).toEqual(['user-token-for-call_1']);
  });

  it('refuses a call whose credential is unavailable: not run, no audit row', async () => {
    const { tool, seen } = credentialTool();
    const events: string[] = [];
    const executor = new ToolExecutor(new ToolRegistry([tool]), {
      credentialFor: () => Promise.reject(new CredentialUnavailableError('The session ended.')),
      audit: {
        started: () => {
          events.push('started');
          return Promise.resolve();
        },
        finished: (_c, outcome) => {
          events.push(`finished ${outcome.status}`);
          return Promise.resolve();
        },
      },
    });
    const result = await executor.run(call('refund_thing', '{"id":"a"}'));
    expect(result).toMatchObject({ ok: false, error: { code: 'credential_unavailable' } });
    expect(seen).toEqual([]);
    expect(events).toEqual(['finished credential_unavailable']);
  });
});

/**
 * Step 4.5 (money safety): the retry policy by tool class. A write is retried only when it
 * carries an idempotency key, always with the same key; without a key it is never retried.
 */
describe('ToolExecutor with idempotency keys', () => {
  /** A write tool that fails once with a retryable error, recording the key of every attempt. */
  function flakyWrite() {
    const keys: (string | undefined)[] = [];
    const tool = defineTool({
      name: 'refund_thing',
      description: 'test tool',
      safety: 'write',
      input: z.object({ id: z.string() }),
      execute: (_args, context) => {
        keys.push(context.idempotencyKey);
        return keys.length === 1 ? Promise.reject(serverError) : Promise.resolve({ ok: true });
      },
    });
    return { tool, keys };
  }
  const fast = { sleep: () => Promise.resolve() };

  it('retries a keyed write on a retryable error, with the same key', async () => {
    const { tool, keys } = flakyWrite();
    const executor = new ToolExecutor(new ToolRegistry([tool]), {
      ...fast,
      idempotencyKeyFor: (c) => `key-${c.id}`,
    });
    expect(await executor.run(call('refund_thing', '{"id":"a"}'))).toMatchObject({ ok: true });
    expect(keys).toEqual(['key-call_1', 'key-call_1']);
  });

  it('never retries a write without a key', async () => {
    const { tool, keys } = flakyWrite();
    const executor = new ToolExecutor(new ToolRegistry([tool]), fast);
    expect(await executor.run(call('refund_thing', '{"id":"a"}'))).toMatchObject({ ok: false });
    expect(keys).toEqual([undefined]);
  });

  it('sends a keyed write that already started again, instead of refusing it', async () => {
    const write = flakyTool('refund_thing', 'write', 0, serverError);
    const executor = new ToolExecutor(new ToolRegistry([write.tool]), {
      idempotencyKeyFor: () => 'key-1',
      audit: {
        started: () => Promise.reject(new WriteAlreadyStartedError('started before')),
        finished: () => Promise.resolve(),
      },
    });
    expect(await executor.run(call('refund_thing', '{"id":"a"}'))).toMatchObject({ ok: true });
    expect(write.calls()).toBe(1);
  });
});

/**
 * Step 4.5: an open circuit and a used-up rate stop a call before anything is sent; a 4xx
 * counts as the API working, a 5xx as it failing.
 */
describe('ToolExecutor with a circuit breaker and a rate limit', () => {
  it('fails fast while the circuit is open, without calling the tool', async () => {
    const read = flakyTool('get_thing', 'read', 99, serverError);
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 60_000 });
    const executor = new ToolExecutor(new ToolRegistry([read.tool]), {
      breaker,
      maxRetries: 0,
      sleep: () => Promise.resolve(),
    });
    await executor.run(call('get_thing', '{"id":"a"}'));
    await executor.run(call('get_thing', '{"id":"a"}'));
    expect(breaker.state()).toBe('open');
    const result = await executor.run(call('get_thing', '{"id":"a"}'));
    expect(result).toMatchObject({ ok: false, error: { code: 'circuit_open' } });
    expect(read.calls()).toBe(2);
  });

  it('does not count a 4xx answer as a failure', async () => {
    const notFound = new ToolExecutionError('http_error', 'HTTP 404', { status: 404 });
    const read = flakyTool('get_thing', 'read', 99, notFound);
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const executor = new ToolExecutor(new ToolRegistry([read.tool]), { breaker });
    await executor.run(call('get_thing', '{"id":"a"}'));
    expect(breaker.state()).toBe('closed');
  });

  it('waits out a short rate wait, and refuses a long one without calling the tool', async () => {
    const read = flakyTool('get_thing', 'read', 0, serverError);
    const waits: number[] = [];
    let answers = [
      { allowed: false, retryAfterMs: 300 },
      { allowed: true, retryAfterMs: 0 },
    ];
    const executor = new ToolExecutor(new ToolRegistry([read.tool]), {
      rateLimit: () => Promise.resolve(answers.shift() ?? { allowed: true, retryAfterMs: 0 }),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(await executor.run(call('get_thing', '{"id":"a"}'))).toMatchObject({ ok: true });
    expect(waits).toEqual([300]);

    answers = [{ allowed: false, retryAfterMs: 60_000 }];
    const refused = await executor.run(call('get_thing', '{"id":"a"}'));
    expect(refused).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(read.calls()).toBe(1);
  });
});
