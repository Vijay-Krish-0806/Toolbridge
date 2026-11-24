/**
 * Step 4.8, kept as a test because it guards access and data integrity: a cached result must never
 * get around the access or session check, and a write must end everything cached before it, also
 * when it failed, and also for a read that was under way while it ran.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CredentialUnavailableError, type ToolAuditor } from './audit.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ToolExecutionError } from './errors.js';
import { ToolExecutor, type ToolExecutorOptions } from './executor.js';
import { ToolRegistry } from './registry.js';
import type { ToolResultCache } from './result-cache.js';
import { defineTool, type Tool } from './tool.js';

/** The smallest correct cache: entries tagged with the version they were looked up under. */
function memoryCache() {
  const entries = new Map<string, { version: number; content: string }>();
  let version = 0;
  const cache: ToolResultCache = {
    lookup: ({ toolName, args }) => {
      const key = `${toolName} ${JSON.stringify(args)}`;
      const entry = entries.get(key);
      const seen = version;
      if (entry?.version === seen) return Promise.resolve({ hit: true, content: entry.content });
      return Promise.resolve({
        hit: false,
        store: (content) => {
          entries.set(key, { version: seen, content });
          return Promise.resolve();
        },
      });
    },
    invalidate: () => {
      version++;
      return Promise.resolve();
    },
  };
  return cache;
}

/** A tiny API: `thing_get` reads a value, `thing_set` changes it; `gate` holds an answer back. */
function api() {
  let value = 'old';
  let reads = 0;
  const gate: {
    read?: Promise<void>;
    write?: Promise<void>;
    failWrite?: boolean;
    failRead?: boolean;
  } = {};
  const input = z.object({ id: z.string().optional() });
  const tools: Tool[] = [
    defineTool({
      name: 'thing_get',
      description: 'x',
      safety: 'read',
      input,
      execute: async () => {
        reads++;
        const seen = value;
        await gate.read;
        if (gate.failRead) throw new ToolExecutionError('http_error', 'HTTP 404');
        return { value: seen };
      },
    }),
    defineTool({
      name: 'thing_set',
      description: 'x',
      safety: 'write',
      input,
      execute: async () => {
        await gate.write;
        value = 'new';
        if (gate.failWrite) throw new ToolExecutionError('timeout', 'no answer in time');
        return { ok: true };
      },
    }),
    defineTool({
      name: 'note_save',
      description: 'x',
      safety: 'write',
      local: true,
      input,
      execute: () => Promise.resolve({ saved: true }),
    }),
  ];
  return { tools, gate, reads: () => reads };
}

function setup(options: ToolExecutorOptions = {}) {
  const it = api();
  const cache = options.cache ?? memoryCache();
  const executor = new ToolExecutor(new ToolRegistry(it.tools), { ...options, cache });
  const run = (name: string, args = '{}', principal?: { userId: string; role: string }) =>
    executor.run({ id: 'c1', name, arguments: args }, principal ? { principal } : {});
  return { ...it, cache, run };
}

const OLD = '{"value":"old"}';
const NEW = '{"value":"new"}';

describe('tool-result cache in the executor', () => {
  it('answers a repeated read from the cache and says so in the audit', async () => {
    const audited: boolean[] = [];
    const audit: ToolAuditor = {
      started: () => Promise.resolve(),
      finished: (_call, outcome) => {
        audited.push(outcome.cached);
        return Promise.resolve();
      },
    };
    const { run, reads } = setup({ audit });
    expect(await run('thing_get')).toEqual({ ok: true, content: OLD });
    expect(await run('thing_get')).toEqual({ ok: true, content: OLD, cached: true });
    expect(await run('thing_get', '{"id":"other"}')).toEqual({ ok: true, content: OLD });
    expect(reads()).toBe(2);
    expect(audited).toEqual([false, true, false]);
  });

  it('a write ends what was cached before it', async () => {
    const { run } = setup();
    await run('thing_get');
    await run('thing_set');
    expect(await run('thing_get')).toEqual({ ok: true, content: NEW });
  });

  it('a FAILED write does too, also for a read during it: it may have been done', async () => {
    const { run, gate } = setup();
    let release = (): void => undefined;
    gate.write = new Promise((resolve) => {
      release = resolve;
    });
    gate.failWrite = true;
    const write = run('thing_set');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await run('thing_get'); // starts and ends while the write is under way: caches the old value
    release();
    expect(await write).toMatchObject({ ok: false });
    expect(await run('thing_get')).toEqual({ ok: true, content: NEW });
  });

  it('a write is never answered from the cache', async () => {
    const { run } = setup({
      cache: {
        lookup: () => Promise.resolve({ hit: true, content: '"from the cache"' }),
        invalidate: () => Promise.resolve(),
      },
    });
    expect(await run('thing_set')).toEqual({ ok: true, content: '{"ok":true}' });
  });

  it('a read that was under way during a write is not served later', async () => {
    const { run, gate } = setup();
    let release = (): void => undefined;
    gate.read = new Promise((resolve) => {
      release = resolve;
    });
    const slow = run('thing_get'); // has already seen the old value at the API
    await new Promise((resolve) => setTimeout(resolve, 0));
    await run('thing_set');
    release();
    expect(await slow).toEqual({ ok: true, content: OLD }); // it did start before the write
    expect(await run('thing_get')).toEqual({ ok: true, content: NEW });
  });

  it('invalidates before AND after a write (a process that dies in between, reads meanwhile)', async () => {
    const order: string[] = [];
    const cache: ToolResultCache = {
      lookup: () => Promise.resolve(undefined),
      invalidate: () => {
        order.push('invalidate');
        return Promise.resolve();
      },
    };
    const { tools } = api();
    const write = defineTool({
      name: 'thing_set',
      description: 'x',
      safety: 'write',
      input: z.object({}),
      execute: () => {
        order.push('write');
        return Promise.resolve({});
      },
    });
    const registry = new ToolRegistry([...tools.filter((t) => t.name !== 'thing_set'), write]);
    const executor = new ToolExecutor(registry, { cache });
    await executor.run({ id: 'c1', name: 'thing_set', arguments: '{}' });
    expect(order).toEqual(['invalidate', 'write', 'invalidate']);
    await executor.run({ id: 'c2', name: 'note_save', arguments: '{}' }); // local: not this API
    await executor.run({ id: 'c3', name: 'thing_get', arguments: '{}' });
    expect(order).toHaveLength(3);
  });

  it('a forbidden role gets nothing from the cache', async () => {
    const { run } = setup({
      authorizer: {
        authorize: (principal) =>
          principal.role === 'support'
            ? { allowed: true }
            : { allowed: false, reason: 'not allowed' },
      },
    });
    const support = { userId: 'u1', role: 'support' };
    await run('thing_get', '{}', support);
    expect(await run('thing_get', '{}', support)).toMatchObject({ cached: true });
    expect(await run('thing_get', '{}', { userId: 'u1', role: 'guest' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('a user whose session has ended gets nothing from the cache', async () => {
    let ended = false;
    const { run } = setup({
      credentialFor: () =>
        ended
          ? Promise.reject(new CredentialUnavailableError('Session ended.'))
          : Promise.resolve(undefined),
    });
    await run('thing_get');
    expect(await run('thing_get')).toMatchObject({ cached: true });
    ended = true;
    expect(await run('thing_get')).toMatchObject({
      ok: false,
      error: { code: 'credential_unavailable' },
    });
  });

  it('never stores an error', async () => {
    const { run, gate, reads } = setup();
    gate.failRead = true;
    expect(await run('thing_get')).toMatchObject({ ok: false });
    gate.failRead = false;
    expect(await run('thing_get')).toEqual({ ok: true, content: OLD });
    expect(reads()).toBe(2);
  });

  it('a hit needs neither the API nor its rate: it works while the circuit is open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const { run } = setup({ breaker });
    await run('thing_get');
    breaker.recordFailure();
    expect(await run('thing_get')).toMatchObject({ ok: true, cached: true });
    expect(await run('thing_get', '{"id":"x"}')).toMatchObject({
      ok: false,
      error: { code: 'circuit_open' },
    });
  });

  it('a cache that fails is ignored', async () => {
    const down = () => Promise.reject(new Error('redis down'));
    const unreadable = setup({ cache: { lookup: down, invalidate: down } });
    expect(await unreadable.run('thing_get')).toEqual({ ok: true, content: OLD });
    expect(await unreadable.run('thing_set')).toMatchObject({ ok: true });
    const unwritable = setup({
      cache: { lookup: () => Promise.resolve({ hit: false, store: down }), invalidate: down },
    });
    expect(await unwritable.run('thing_get')).toEqual({ ok: true, content: OLD });
  });
});
