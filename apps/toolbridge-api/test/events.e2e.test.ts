/**
 * Step 4.4a session (b) acceptance: the persisted event log and its stream.
 * - A run's stream: numbers 1..N with no gaps, every event valid against the public v1 schema,
 *   no internal data (model reasoning, tool results), ending with run_finished.
 * - A client replays missed events by sequence number (Last-Event-ID or ?after=).
 * - Closing the stream (the tab) does not stop the run.
 * - The approval flow and a cancel show up as events.
 * - REQUIRED (tenant isolation): another tenant cannot open a run's stream.
 *
 * Read over real HTTP with fetch, as a browser client would (an Authorization header, no token
 * in the URL). An in-process worker runs the legs with a scripted model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import { parseRunEvent, RUN_EVENT_TYPES, type RunEvent } from '@toolbridge/run-events';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostPolicy,
  hostSpec,
  mintSession,
  startHarness,
} from './harness.js';

const TOKEN = 'events-e2e-token';
/** Text that must never reach a client: the model's reasoning and a tool's raw result. */
const SECRET_THOUGHT = 'SECRET-THOUGHT-7f3';
const RESULT_MARKER = 'RESULT-MARKER-91c';

/**
 * A scripted model that streams reasoning first (which must stay internal), then decides from
 * the conversation: "look ORD-7" -> one orders_get; "refund ORD-7 N" -> one refund; after a tool
 * result -> a text answer; "slow" -> waits 1.5 s before answering.
 */
class EventModel implements LLMProvider {
  private calls = 0;

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls++;
    const last = request.messages.at(-1);
    const user = request.messages.findLast((m) => m.role === 'user')?.content ?? '';
    if (user.includes('slow')) await new Promise((r) => setTimeout(r, 1500));
    if (last?.role === 'tool' || user.includes('slow')) {
      return {
        message: { role: 'assistant', content: 'Order ORD-7 is handled. All done.', toolCalls: [] },
        finishReason: 'stop',
      };
    }
    const refund = /refund (\S+) (\d+)/.exec(user);
    const call = refund
      ? {
          name: 'refunds_request',
          args: { orderId: refund[1], amountCents: Number(refund[2]), reason: 'damaged' },
        }
      : { name: 'orders_get', args: { number: 'ORD-7' } };
    return {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: `c${String(this.calls)}`, name: call.name, arguments: JSON.stringify(call.args) },
        ],
      },
      finishReason: 'tool_calls',
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    yield { type: 'reasoning-delta', text: SECRET_THOUGHT };
    const result = await this.generate(request);
    for (const word of result.message.content.split(/(?<=\s)/)) {
      if (word) yield { type: 'text-delta', text: word };
    }
    for (const toolCall of result.message.toolCalls) yield { type: 'tool-call', toolCall };
    yield { type: 'done', result };
  }
}

let h: Harness;
let base: string;
let upstream: Server;
let refunds = 0;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('{}');
      } else if (req.url?.startsWith('/orders/by-number/')) {
        res.end(JSON.stringify({ number: 'ORD-7', status: 'paid', note: RESULT_MARKER }));
      } else if (req.method === 'POST' && req.url === '/refunds') {
        refunds++;
        res
          .writeHead(201)
          .end(JSON.stringify({ id: 'r1', status: 'pending', note: RESULT_MARKER }));
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, resolve));
  h = await startHarness({}, { llm: new EventModel() });
  await h.app.listen(0, '127.0.0.1');
  const address = (h.app.getHttpServer() as Server).address() as AddressInfo;
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await h.stop();
  upstream.closeAllConnections();
  upstream.close();
});

const http = () => h.http;
const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${key}`),
});

/** A tenant with the host spec, a connection to the fake API, refunds enabled, the host policy. */
/** A test tenant: its API key and spec, and session tokens for u1 (asks) and u2 (approves). */
interface TestTenant {
  key: string;
  specId: string;
  u1: string;
  u2: string;
}

async function tenant(name: string): Promise<TestTenant> {
  const t = await createTenant(h.http, name);
  const spec = await as(t.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  const port = String((upstream.address() as AddressInfo).port);
  await as(t.key)
    .put(`/specs/${specId}/connection`)
    .send({ baseUrl: `http://localhost:${port}`, authKind: 'static', secrets: { bearer: TOKEN } })
    .expect(200);
  await as(t.key)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .send({ enabled: true })
    .expect(200);
  await as(t.key).put(`/specs/${specId}/policy`).send({ policy: hostPolicy() }).expect(200);
  // Session tokens, as the host's backend would mint them: u1 asks, u2 approves.
  const u1 = await mintSession(http(), t.key, specId, 'u1');
  const u2 = await mintSession(http(), t.key, specId, 'u2');
  return { key: t.key, specId, u1, u2 };
}

async function startRun(t: TestTenant, message: string): Promise<string> {
  const started = await as(t.u1).post('/runs').send({ message }).expect(202);
  return body<{ runId: string }>(started).runId;
}

async function waitFor(key: string, runId: string, status: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = body<{ status: string }>(await as(key).get(`/runs/${runId}`).expect(200));
    if (run.status === status) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

/**
 * Reads a run's stream the way a browser client does: fetch with an Authorization header,
 * parsing SSE blocks. Stops when the server closes the stream, after `max` events, or when
 * `until` matches (then the client disconnects).
 */
async function readStream(
  key: string,
  runId: string,
  options: {
    lastEventId?: number;
    after?: number;
    max?: number;
    until?: (e: RunEvent) => boolean;
  } = {},
): Promise<{ status: number; events: RunEvent[]; closedByServer: boolean }> {
  const controller = new AbortController();
  const query = options.after === undefined ? '' : `?after=${String(options.after)}`;
  const response = await fetch(`${base}/runs/${runId}/events${query}`, {
    headers: {
      authorization: `Bearer ${key}`,
      ...(options.lastEventId !== undefined && { 'last-event-id': String(options.lastEventId) }),
    },
    signal: controller.signal,
  });
  const events: RunEvent[] = [];
  if (!response.ok || !response.body)
    return { status: response.status, events, closedByServer: false };
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body.getReader();
  for (;;) {
    // The lib has no DOM types, so the reader's chunk type is given here.
    const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
    if (done) return { status: response.status, events, closedByServer: true };
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue; // a heartbeat comment
      const event = parseRunEvent(JSON.parse(data.slice(6)));
      expect(block).toContain(`id: ${String(event.seq)}\nevent: ${event.type}\n`);
      events.push(event);
      if (events.length === options.max || options.until?.(event)) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        return { status: response.status, events, closedByServer: false };
      }
    }
  }
}

let alice: TestTenant;
let bob: TestTenant;

beforeAll(async () => {
  alice = await tenant('Alice');
  bob = await tenant('Bob');
});

describe('run events', () => {
  it('streams 1..N without gaps, only public v1 events, and ends with run_finished', async () => {
    const runId = await startRun(alice, 'look ORD-7');
    const { events, closedByServer } = await readStream(alice.u1, runId);

    expect(closedByServer).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1));
    expect(events.every((e) => RUN_EVENT_TYPES.includes(e.type) && e.runId === runId)).toBe(true);
    const types = events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['tool_call_started', 'tool_call_finished']);
    expect(types.at(-1)).toBe('run_finished');
    expect(types).toContain('text_delta');
    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.data.text] : [])).join('');
    expect(text).toBe('Order ORD-7 is handled. All done.');
    expect(events.at(-1)).toMatchObject({ data: { status: 'completed', stopReason: 'answer' } });
    // Internal data never reaches a client.
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(SECRET_THOUGHT);
    expect(wire).not.toContain(RESULT_MARKER);
  });

  it('replays exactly the missed events after Last-Event-ID or ?after=', async () => {
    const runId = await startRun(alice, 'look ORD-7');
    await waitFor(alice.u1, runId, 'completed');
    const all = (await readStream(alice.u1, runId)).events;
    const firstTwo = (await readStream(alice.u1, runId, { max: 2 })).events;
    expect(firstTwo.map((e) => e.seq)).toEqual([1, 2]);

    const byHeader = (await readStream(alice.u1, runId, { lastEventId: 2 })).events;
    expect(byHeader).toEqual(all.slice(2));
    const byQuery = (await readStream(alice.u1, runId, { after: 2 })).events;
    expect(byQuery).toEqual(all.slice(2));
  });

  it('closing the stream (the tab) does not stop the run', async () => {
    const runId = await startRun(alice, 'slow one');
    const early = await readStream(alice.u1, runId, { max: 1 }); // disconnects at once
    expect(early.closedByServer).toBe(false);
    await waitFor(alice.u1, runId, 'completed');
    const rest = (await readStream(alice.u1, runId, { lastEventId: early.events.length })).events;
    expect(rest.at(-1)).toMatchObject({ type: 'run_finished', data: { status: 'completed' } });
  });

  it('shows the approval card, then the approved write and the end, across two connections', async () => {
    const before = refunds;
    const runId = await startRun(alice, 'refund ORD-7 32893');
    const first = await readStream(alice.u1, runId, {
      until: (e) => e.type === 'approval_required',
    });
    const card = first.events.at(-1);
    expect(card).toMatchObject({
      type: 'approval_required',
      data: {
        level: 'high',
        calls: [
          {
            tool: 'refunds_request',
            arguments: '{"orderId":"ORD-7","amountCents":32893,"reason":"damaged"}',
            level: 'high',
          },
        ],
      },
    });
    expect(refunds - before).toBe(0);
    if (card?.type !== 'approval_required') throw new Error('no card');

    await as(alice.u2).post(`/approvals/${card.data.approvalId}/approve`).send({}).expect(202);
    const second = await readStream(alice.u1, runId, { lastEventId: card.seq });
    expect(second.events.map((e) => e.seq)[0]).toBe(card.seq + 1);
    expect(second.events.map((e) => e.type).slice(0, 2)).toEqual([
      'tool_call_started',
      'tool_call_finished',
    ]);
    expect(second.events[1]).toMatchObject({ data: { tool: 'refunds_request', ok: true } });
    expect(second.events.at(-1)).toMatchObject({ data: { status: 'completed' } });
    expect(refunds - before).toBe(1);
  });

  it('cancelling a waiting run ends its stream with run_finished "cancelled"', async () => {
    const runId = await startRun(alice, 'refund ORD-7 40000');
    const first = await readStream(alice.u1, runId, {
      until: (e) => e.type === 'approval_required',
    });
    await as(alice.u1).post(`/runs/${runId}/cancel`).expect(202);
    const rest = await readStream(alice.u1, runId, { lastEventId: first.events.length });
    expect(rest.closedByServer).toBe(true);
    expect(rest.events.map((e) => [e.type, e.type === 'run_finished' && e.data.status])).toEqual([
      ['run_finished', 'cancelled'],
    ]);
  });

  it("another tenant cannot open a run's stream (404)", async () => {
    const runId = await startRun(alice, 'look ORD-7');
    const response = await readStream(bob.u1, runId);
    expect(response.status).toBe(404);
    expect(response.events).toEqual([]);
  });
});
