/**
 * Step 4.8 acceptance: repeated reads hit the cache, and writes invalidate correctly. On real Redis,
 * through real runs; a fake host API counts the requests it gets.
 * - REQUIRED (tenant isolation): tenants, users, roles, credential modes and the approver of a
 *   call never share an entry.
 * - Data integrity: a write ends every cached read of that API (also of OTHER resources, also when
 *   it comes from a direct tool call or another spec), and a read that overlapped it is not served.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostSpec,
  startHarness,
} from './harness.js';

const ORDER_ID = 'a'.repeat(24);
const PRODUCT_ID = 'b'.repeat(24);

/** What the host holds, and every request it got ("<token> <method> <path>"). */
const host = { status: 'paid', reserved: 5 };
const seen: string[] = [];
/** When set, the host answers a read of ORD-SLOW only after this (it has read its data by then). */
let hold: Promise<void> | undefined;
let reached: (() => void) | undefined;

let upstream: Server;
let baseUrl: string;

function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const path = req.url ?? '';
      seen.push(`${token} ${req.method ?? ''} ${path}`);
      const answer = (data: unknown, status = 200) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.method === 'POST' && path.endsWith('/cancel')) {
        host.status = 'cancelled';
        host.reserved = 0;
        answer({ status: host.status });
      } else if (req.method !== 'GET') {
        answer({ ok: true });
      } else if (path.startsWith('/orders/by-number/')) {
        const data = { number: path.split('/').at(-1), status: host.status, viewer: token };
        if (!path.endsWith('SLOW') || !hold) return answer(data);
        reached?.();
        void hold.then(() => answer(data));
      } else if (path.startsWith('/inventory/products/')) {
        answer([{ reserved: host.reserved, viewer: token }]);
      } else {
        answer({ message: 'not found' }, 404);
      }
      return undefined;
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      resolve(server);
    }),
  );
}

/** A model that makes exactly the calls the user's message lists, then quotes their results. */
class ListedCallsModel implements LLMProvider {
  private calls = 0;
  generate(req: GenerateRequest): Promise<GenerateResult> {
    const last = req.messages.at(-1);
    if (last?.role === 'tool') {
      const at = req.messages.findLastIndex((m) => m.role === 'user');
      const results = req.messages.slice(at).filter((m) => m.role === 'tool');
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: results.map((m) => m.content).join('\n'),
          toolCalls: [],
        },
        finishReason: 'stop',
      });
    }
    const listed = JSON.parse(last?.content ?? '[]') as [string, string][];
    return Promise.resolve({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: listed.map(([name, args]) => ({
          id: `c${String(++this.calls)}`,
          name,
          arguments: args,
        })),
      },
      finishReason: 'tool_calls',
    });
  }
  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(req)]).stream(req);
  }
}

let h: Harness;
const as = (token: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${token}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${token}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${token}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${token}`),
});

/** Every role may do everything without a card, except changing notes (needs an approval). */
const POLICY = {
  version: 1,
  roles: { owner: { allow: ['*'] }, support: { allow: ['*'] } },
  approvals: {
    default: 'none',
    rules: [{ tools: ['orders_update_notes'], approval: 'required' }],
  },
};

interface Tenant {
  key: string;
  specId: string;
}

const connect = (t: Tenant, ttl: number | undefined, token: string) =>
  as(t.key)
    .put(`/specs/${t.specId}/connection`)
    .send({
      baseUrl,
      authKind: 'static',
      secrets: { bearer: token },
      ...(ttl !== undefined && { cacheTtlSeconds: ttl }),
    })
    .expect(200);

async function addSpec(key: string, name: string, ttl: number | undefined, token: string) {
  const spec = await as(key)
    .post('/specs')
    .send({ name, document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const t = { key, specId: body<{ spec: { id: string } }>(spec).spec.id };
  await connect(t, ttl, token);
  for (const tool of ['orders_cancel', 'orders_update_notes']) {
    await as(key).patch(`/specs/${t.specId}/tools/${tool}`).send({ enabled: true }).expect(200);
  }
  await as(key).put(`/specs/${t.specId}/policy`).send({ policy: POLICY }).expect(200);
  return t;
}

async function tenant(
  options: { ttl?: number; mode?: 'delegated'; token?: string } = {},
): Promise<Tenant> {
  const { key } = await createTenant(h.http, 'Cache');
  const t = await addSpec(key, 'store', options.ttl ?? 300, options.token ?? 'svc');
  if (options.mode) {
    await as(key).put('/tenant/credential-mode').send({ mode: options.mode }).expect(200);
  }
  return t;
}

async function session(t: Tenant, userId: string, role = 'support', userToken?: string) {
  const minted = await as(t.key)
    .post('/sessions')
    .send({ specId: t.specId, userId, role, ...(userToken && { userToken }) })
    .expect(201);
  return body<{ token: string }>(minted).token;
}

interface RunView {
  status: string;
  answer: string | null;
  approvalId: string | null;
}

async function waitFor(token: string, runId: string, status: string): Promise<RunView> {
  for (let i = 0; i < 200; i++) {
    const run = body<RunView>(await as(token).get(`/runs/${runId}`).expect(200));
    if (run.status === status) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run never reached ${status}`);
}

type Call = [name: string, args: Record<string, unknown> | string];
async function start(token: string, ...calls: Call[]): Promise<string> {
  const message = JSON.stringify(
    calls.map(([name, args]) => [name, typeof args === 'string' ? args : JSON.stringify(args)]),
  );
  const started = await as(token).post('/runs').send({ message }).expect(202);
  return body<{ runId: string }>(started).runId;
}

/** Runs the calls to the end; returns the results and the requests the host got meanwhile. */
async function ask(token: string, ...calls: Call[]): Promise<{ answer: string; sent: number }> {
  const before = seen.length;
  const runId = await start(token, ...calls);
  const { answer } = await waitFor(token, runId, 'completed');
  return { answer: answer ?? '', sent: seen.length - before };
}

const order = (number = 'ORD-7'): Call => ['orders_get', { number }];
const stock: Call = ['inventory_for_product', { productId: PRODUCT_ID }];
const cancel: Call = ['orders_cancel', { id: ORDER_ID, reason: 'test' }];

beforeAll(async () => {
  upstream = await startUpstream();
  baseUrl = `http://localhost:${String((upstream.address() as AddressInfo).port)}`;
  h = await startHarness({ MAX_SPECS_PER_TENANT: '5' }, { llm: new ListedCallsModel() });
});

afterAll(async () => {
  await h.stop();
  upstream.closeAllConnections();
  upstream.close();
});

describe('repeated reads', () => {
  it('hit the cache, across runs and argument spellings, and the audit shows it', async () => {
    const t = await tenant();
    const u = await session(t, 'u1');
    expect((await ask(u, ['inventory_list', { page: 1, limit: 5 }])).sent).toBe(1); // 404: not kept
    expect((await ask(u, ['inventory_list', { page: 1, limit: 5 }])).sent).toBe(1);

    const first = await ask(u, order());
    expect(first.sent).toBe(1);
    expect(await ask(u, order())).toEqual({ answer: first.answer, sent: 0 });
    expect((await ask(u, ['orders_get', '{ "number" : "ORD-7" }'])).sent).toBe(0);
    expect((await ask(u, order('ORD-8'))).sent).toBe(1);

    const rows = body<{ cached: boolean; status: string }[]>(
      await as(t.key).get('/audit?toolName=orders_get').expect(200),
    );
    expect(rows.map((r) => [r.status, r.cached])).toEqual([
      ['ok', false],
      ['ok', true],
      ['ok', true],
      ['ok', false],
    ]);
  });

  it('are never cached unless the tenant turned it on', async () => {
    const t = await tenant({ ttl: 0 });
    const u = await session(t, 'u1');
    await ask(u, order());
    expect((await ask(u, order())).sent).toBe(1);
    await connect(t, undefined, 'svc');
    await ask(u, order());
    expect((await ask(u, order())).sent).toBe(1);
  });

  it('end with the TTL', async () => {
    const t = await tenant({ ttl: 1 });
    const u = await session(t, 'u1');
    await ask(u, order());
    await new Promise((r) => setTimeout(r, 1100));
    expect((await ask(u, order())).sent).toBe(1);
  });

  it('end when the connection is set again', async () => {
    const t = await tenant();
    const u = await session(t, 'u1');
    await ask(u, order());
    expect((await ask(u, order())).sent).toBe(0);
    await connect(t, 300, 'svc-2'); // another credential may see other data
    const { answer, sent } = await ask(u, order());
    expect([sent, answer]).toEqual([1, expect.stringContaining('svc-2')]);
  });

  it('end with a new spec version, which may shape results differently', async () => {
    const t = await tenant();
    const u = await session(t, 'u1');
    expect((await ask(u, stock)).answer).toContain('viewer');
    const overrides = hostOverrides() as { operations: Record<string, unknown> };
    overrides.operations.InventoryController_forProduct = { result: { fields: ['reserved'] } };
    await as(t.key)
      .post(`/specs/${t.specId}/versions`)
      .send({ document: hostSpec(), overrides })
      .expect(201);
    const shaped = await ask(u, stock);
    expect(shaped.sent).toBe(1);
    expect(shaped.answer).not.toContain('viewer');
  });

  it('refuses a TTL above five minutes', async () => {
    const t = await tenant();
    await as(t.key)
      .put(`/specs/${t.specId}/connection`)
      .send({ baseUrl, authKind: 'none', cacheTtlSeconds: 301 })
      .expect(400);
  });
});

describe('isolation', () => {
  it('two tenants with the same API never share', async () => {
    const a = await session(await tenant({ token: 'svc-a' }), 'u1');
    const b = await session(await tenant({ token: 'svc-b' }), 'u1');
    expect((await ask(a, order())).answer).toContain('svc-a');
    const other = await ask(b, order());
    expect([other.sent, other.answer]).toEqual([1, expect.stringContaining('svc-b')]);
  });

  it('service mode: shared inside a role, not between roles', async () => {
    const t = await tenant();
    await ask(await session(t, 'u1', 'support'), order());
    expect((await ask(await session(t, 'u2', 'support'), order())).sent).toBe(0);
    expect((await ask(await session(t, 'u1', 'owner'), order())).sent).toBe(1);
  });

  it('delegated mode: one user each, and never the service results', async () => {
    const t = await tenant();
    await ask(await session(t, 'u1'), order()); // cached in service mode, as role support
    await as(t.key).put('/tenant/credential-mode').send({ mode: 'delegated' }).expect(200);
    const u1 = await session(t, 'u1', 'support', 'tok-u1');
    const u2 = await session(t, 'u2', 'support', 'tok-u2');
    const first = await ask(u1, order());
    expect([first.sent, first.answer]).toEqual([1, expect.stringContaining('tok-u1')]);
    expect((await ask(u1, order())).sent).toBe(0);
    const second = await ask(u2, order());
    expect([second.sent, second.answer]).toEqual([1, expect.stringContaining('tok-u2')]);
  });

  it("an approved call's result is the approver's, not the requester's", async () => {
    const t = await tenant({ mode: 'delegated' });
    const sam = await session(t, 'sam', 'support', 'tok-sam');
    const lee = await session(t, 'lee', 'support', 'tok-lee');
    const runId = await start(
      sam,
      ['orders_update_notes', { id: ORDER_ID, notes: 'x' }],
      order('ORD-9'),
    );
    const paused = await waitFor(sam, runId, 'waiting_for_approval');
    await as(lee)
      .post(`/approvals/${paused.approvalId ?? ''}/approve`)
      .send({})
      .expect(202);
    const done = await waitFor(sam, runId, 'completed');
    expect(done.answer).toContain('tok-lee'); // the whole card ran as lee

    const own = await ask(sam, order('ORD-9'));
    expect([own.sent, own.answer]).toEqual([1, expect.stringContaining('tok-sam')]);
    expect((await ask(lee, order('ORD-9'))).sent).toBe(0);
  });
});

describe('writes invalidate', () => {
  const reset = () => {
    host.status = 'paid';
    host.reserved = 5;
  };

  it('cancelling an order also ends the cached inventory (another resource)', async () => {
    reset();
    const u = await session(await tenant(), 'u1');
    expect((await ask(u, order(), stock)).answer).toContain('"reserved":5');
    expect((await ask(u, order(), stock)).sent).toBe(0);
    await ask(u, cancel);
    const after = await ask(u, order(), stock);
    expect(after.sent).toBe(2);
    expect(after.answer).toContain('cancelled');
    expect(after.answer).toContain('"reserved":0');
  });

  it('so do a direct tool call and another spec of the same API; another tenant does not', async () => {
    reset();
    const t = await tenant();
    const u = await session(t, 'u1');
    const other = await tenant();
    const otherUser = await session(other, 'u1');
    await ask(u, stock);
    await ask(otherUser, stock);
    await as(t.key)
      .post(`/specs/${t.specId}/tools/orders_cancel/call`)
      .send({ arguments: cancel[1] })
      .expect((r) => {
        expect(body<{ ok: boolean }>(r).ok).toBe(true);
      });
    expect((await ask(u, stock)).answer).toContain('"reserved":0');
    expect((await ask(otherUser, stock)).sent).toBe(0); // until its TTL: a change made elsewhere

    reset();
    await ask(u, cancel);
    reset();
    await ask(u, stock);
    const second = await addSpec(t.key, 'store-2', 300, 'svc');
    await ask(await session(second, 'u1'), cancel);
    expect((await ask(u, stock)).answer).toContain('"reserved":0');
  });

  it('a read that overlapped a write is not served afterwards', async () => {
    reset();
    const t = await tenant();
    const u = await session(t, 'u1');
    let release = (): void => undefined;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow = await start(u, order('ORD-SLOW'));
    await arrived; // the host has read "paid" and is still holding its answer
    await as(t.key)
      .post(`/specs/${t.specId}/tools/orders_cancel/call`)
      .send({ arguments: cancel[1] });
    release();
    hold = undefined;
    expect((await waitFor(u, slow, 'completed')).answer).toContain('paid');
    expect((await ask(u, order('ORD-SLOW'))).answer).toContain('cancelled');
  });
});
