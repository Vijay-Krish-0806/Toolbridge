/**
 * Step 4.4a session (a) acceptance: runs execute on workers, not in the API.
 * - A killed worker's run is picked up by another worker and finishes (REAL worker processes,
 *   killed with SIGKILL, not a simulated crash).
 * - REQUIRED (approvals and idempotency: resuming never executes the same write twice): a worker
 *   killed DURING a write does not get that write repeated by the worker that takes over; the
 *   call reports `outcome_unknown` instead.
 * - REQUIRED (Step 4.5 done-check: kill a worker between a side effect and its acknowledgement,
 *   and no duplicate refund occurs): with idempotency keys, the next worker sends the write
 *   again with the SAME key, the host replays its stored answer, and the run gets the real
 *   result (one refund, audit `ok`).
 * - A run that exceeds its time limit is stopped and marked failed, without retry.
 * - A running run and a waiting run can be cancelled.
 * - A leg that keeps failing ends in the dead-letter set and the run is marked failed.
 *
 * Child workers call a small fake OpenAI-compatible server started here; in-process workers use
 * scripted models. A local fake API stands in for the host store and counts refunds.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostPolicy,
  hostSpec,
  mintSession,
  startHarness,
  testEnv,
} from './harness.js';

const TOKEN = 'worker-e2e-token';
const WORKER_MAIN = new URL('../../toolbridge-worker/dist/main.js', import.meta.url);
/**
 * Time allowed for a test that starts two real worker processes. A cold start takes about 8 to
 * 10 s on a Windows dev machine (mostly loading modules; measured 2026-11-22), plus the 2 s lock
 * and the stalled check, so these get more room than the usual 60 s.
 */
const TWO_WORKERS_MS = 120_000;

/** A model reply for the fake servers and scripted models: text, one tool call, or hang. */
type Reply = { text: string } | { tool: string; args: Record<string, unknown> } | 'hang';

/** Reads a request body as JSON. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    });
  });
}

/** Starts a server on a free port and returns it with its base URL. */
function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      });
    }),
  );
}

// ---- Fake host API: counts refunds; can hang on a refund (the worker dies mid-write). ----
let host: { server: Server; url: string };
const refunds: string[] = [];
let hangOnRefund = false;
/** Idempotency keys the fake host received, and the answer it stored for each (Step 4.5). */
const keysSeen: string[] = [];
const storedByKey = new Map<string, string>();

// ---- Fake OpenAI-compatible model server for child workers. ----
let llm: { server: Server; url: string };
let llmCalls = 0;
let llmReply: (call: number, body: Record<string, unknown>) => Reply = () => ({ text: 'ok' });

/** Writes one reply as an OpenAI streaming response (the format our adapter parses). */
function streamReply(res: ServerResponse, reply: Exclude<Reply, 'hang'>, call: number): void {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: `chunk-${String(call)}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const parts =
    'text' in reply
      ? [chunk({ role: 'assistant', content: reply.text }, null), chunk({}, 'stop')]
      : [
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call-${String(call)}`,
                  type: 'function',
                  function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                },
              ],
            },
            null,
          ),
          chunk({}, 'tool_calls'),
        ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of parts) res.write(`data: ${JSON.stringify(part)}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** The last message's text, for replies that depend on what the model was told. */
function lastContent(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: unknown }[];
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

beforeAll(async () => {
  host = await listen((req, res) => {
    void readJson(req).then((json) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('{}');
      } else if (req.method === 'POST' && req.url === '/refunds') {
        // Like the real host (Step 4.5): a repeated Idempotency-Key gets the stored answer.
        const key = req.headers['idempotency-key'];
        if (typeof key === 'string') keysSeen.push(key);
        const stored = typeof key === 'string' ? storedByKey.get(key) : undefined;
        if (stored) {
          res.writeHead(201, { 'idempotent-replayed': 'true' }).end(stored);
          return;
        }
        refunds.push(JSON.stringify(json));
        const answer = JSON.stringify({ id: `r${String(refunds.length)}`, status: 'pending' });
        if (typeof key === 'string') storedByKey.set(key, answer);
        if (hangOnRefund) return; // never answers: the worker is killed while waiting
        res.writeHead(201).end(answer);
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  llm = await listen((req, res) => {
    void readJson(req).then((json) => {
      llmCalls++;
      const reply = llmReply(llmCalls, json);
      if (reply !== 'hang') streamReply(res, reply, llmCalls);
    });
  });
});

afterAll(() => {
  for (const s of [host.server, llm.server]) {
    s.closeAllConnections();
    s.close();
  }
});

// ---- Child worker processes. ----
const children: ChildProcess[] = [];

/** Starts the real worker program and resolves once it reports it is ready. */
function spawnWorker(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_MAIN.pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...testEnv(), LLM_BASE_URL: `${llm.url}/v1`, LLM_API_KEY: 'fake', LLM_MODEL: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('ToolBridge worker started')) resolve(child);
    });
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('exit', (code) => {
      reject(new Error(`worker exited early (${String(code)}): ${out}`));
    });
  });
}

let h: Harness | undefined;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await h?.stop();
  h = undefined;
  hangOnRefund = false;
  llmCalls = 0;
  refunds.length = 0;
  keysSeen.length = 0;
  storedByKey.clear();
});

// ---- Shared helpers. ----
/** The running harness's HTTP server (each test starts its own harness). */
function http() {
  if (!h) throw new Error('no harness');
  return h.http;
}
const as = (key: string) => ({
  get: (path: string) => request(http()).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(http()).post(path).set('authorization', `Bearer ${key}`),
  put: (path: string) => request(http()).put(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(http()).patch(path).set('authorization', `Bearer ${key}`),
});

interface RunView {
  id: string;
  status: string;
  answer: string | null;
  error: string | null;
  approvalId: string | null;
}

/** A tenant with the host spec, a connection to the fake API, refunds enabled, and `policy`. */
async function tenant(policy: Record<string, unknown> = hostPolicy(), idempotent = false) {
  if (!h) throw new Error('no harness');
  const t = await createTenant(h.http, `T${String(Date.now())}`);
  const spec = await as(t.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await as(t.key)
    .put(`/specs/${specId}/connection`)
    .send({
      baseUrl: host.url.replace('127.0.0.1', 'localhost'),
      authKind: 'static',
      secrets: { bearer: TOKEN },
      ...(idempotent && { idempotencyHeader: 'Idempotency-Key' }),
    })
    .expect(200);
  await as(t.key)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .send({ enabled: true })
    .expect(200);
  await as(t.key).put(`/specs/${specId}/policy`).send({ policy }).expect(200);
  // Session tokens, as the host's backend would mint them: u1 asks, u2 approves.
  const u1 = await mintSession(http(), t.key, specId, 'u1');
  const u2 = await mintSession(http(), t.key, specId, 'u2');
  return { key: t.key, specId, u1, u2 };
}

/** Starts a run as support user u1 and returns its id. */
async function startRun(t: { u1: string }, message = 'refund ORD-7 500') {
  const started = await as(t.u1).post('/runs').send({ message }).expect(202);
  return body<{ runId: string }>(started).runId;
}

/** Polls a run until it has one of `statuses`. */
async function waitFor(key: string, runId: string, ...statuses: string[]): Promise<RunView> {
  for (let i = 0; i < 400; i++) {
    const run = body<RunView>(await as(key).get(`/runs/${runId}`).expect(200));
    if (statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} never reached ${statuses.join('/')}`);
}

/** Waits until `check` is true (for example the model was called). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!check()) throw new Error('condition never became true');
}

/** An in-process scripted model: `reply` decides each call; 'hang' never answers. */
class ScriptModel implements LLMProvider {
  calls = 0;
  constructor(private readonly reply: (call: number, request: GenerateRequest) => Reply | Error) {}

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls++;
    const reply = this.reply(this.calls, request);
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply === 'hang') return new Promise(() => undefined); // ignores the abort signal on purpose
    return Promise.resolve(
      'text' in reply
        ? {
            message: { role: 'assistant', content: reply.text, toolCalls: [] },
            finishReason: 'stop',
          }
        : {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: `c${String(this.calls)}`,
                  name: reply.tool,
                  arguments: JSON.stringify(reply.args),
                },
              ],
            },
            finishReason: 'tool_calls',
          },
    );
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(request)]).stream(request);
  }
}

/** Support may request refunds without approval: isolates the crash tests from the card flow. */
const NO_APPROVAL_POLICY = {
  version: 1,
  roles: { support: { allow: ['refunds_request'] } },
  approvals: { default: 'none', rules: [] },
};

describe('runs on workers', () => {
  it(
    'a killed worker’s run is picked up by another worker and finishes',
    async () => {
      h = await startHarness();
      const t = await tenant();
      llmReply = (call) => (call === 1 ? 'hang' : { text: 'all good' });
      const first = await spawnWorker();
      const runId = await startRun(t, 'how are you');
      await until(() => llmCalls === 1); // worker 1 is inside the model call
      first.kill('SIGKILL');

      await spawnWorker();
      const done = await waitFor(t.u1, runId, 'completed', 'failed');
      expect(done).toMatchObject({ status: 'completed', answer: 'all good' });
      expect(llmCalls).toBe(2);
    },
    TWO_WORKERS_MS,
  );

  it(
    'with idempotency keys, a worker killed between the refund and its answer: one refund, real result',
    async () => {
      h = await startHarness();
      const t = await tenant(NO_APPROVAL_POLICY, true);
      llmReply = (call, json) =>
        call === 1
          ? {
              tool: 'refunds_request',
              args: { orderId: 'ORD-7', amountCents: 500, reason: 'damaged' },
            }
          : { text: `final: ${lastContent(json)}` };
      hangOnRefund = true; // the host files the refund, but its answer never arrives
      const first = await spawnWorker();
      const runId = await startRun(t);
      await until(() => refunds.length === 1);
      first.kill('SIGKILL');

      await spawnWorker();
      const done = await waitFor(t.u1, runId, 'completed', 'failed');
      expect(done.status).toBe('completed');
      expect(done.answer).toContain('pending'); // the real answer, replayed by the host
      expect(refunds).toHaveLength(1); // no duplicate refund
      expect(keysSeen).toHaveLength(2); // sent twice...
      expect(new Set(keysSeen).size).toBe(1); // ...with the same key
      const audit = body<{ phase: string; status: string | null }[]>(
        await as(t.key).get(`/audit?runId=${runId}&safety=write`).expect(200),
      );
      expect(audit.map((r) => [r.phase, r.status])).toEqual([
        ['finished', 'ok'],
        ['started', null],
      ]);
    },
    TWO_WORKERS_MS,
  );

  it(
    'a worker killed during a write: the next worker does not repeat it (outcome_unknown)',
    async () => {
      h = await startHarness();
      const t = await tenant(NO_APPROVAL_POLICY);
      llmReply = (call, json) =>
        call === 1
          ? {
              tool: 'refunds_request',
              args: { orderId: 'ORD-7', amountCents: 500, reason: 'damaged' },
            }
          : { text: `final: ${lastContent(json)}` };
      hangOnRefund = true; // the refund reaches the API, which never answers
      const first = await spawnWorker();
      const runId = await startRun(t);
      await until(() => refunds.length === 1);
      first.kill('SIGKILL');

      await spawnWorker();
      const done = await waitFor(t.u1, runId, 'completed', 'failed');
      expect(done.status).toBe('completed');
      expect(done.answer).toContain('already started once');
      expect(refunds).toHaveLength(1); // never twice
      const audit = body<{ phase: string; status: string | null }[]>(
        await as(t.key).get(`/audit?runId=${runId}&safety=write`).expect(200),
      );
      expect(audit.map((r) => [r.phase, r.status])).toEqual([
        ['finished', 'outcome_unknown'],
        ['started', null],
      ]);
    },
    TWO_WORKERS_MS,
  );

  it('stops a run at its time limit and marks it failed, without retry', async () => {
    const model = new ScriptModel(() => 'hang');
    h = await startHarness({ RUN_LEG_TIMEOUT_MS: '1500' }, { llm: model });
    const t = await tenant();
    const runId = await startRun(t);
    const done = await waitFor(t.u1, runId, 'failed', 'completed');
    expect(done.error).toContain('time limit');
    await new Promise((r) => setTimeout(r, 3000)); // longer than the first retry's backoff
    expect(model.calls).toBe(1); // not retried
  }, 60_000);

  it('cancels a running run, and a run waiting for approval (its card can no longer be approved)', async () => {
    let refundAsked = false;
    const model = new ScriptModel((_call, req) => {
      if (req.messages.some((m) => m.role === 'user' && m.content.includes('wait'))) return 'hang';
      if (!refundAsked) {
        refundAsked = true;
        return {
          tool: 'refunds_request',
          args: { orderId: 'ORD-7', amountCents: 32893, reason: 'damaged' },
        };
      }
      return { text: 'done' };
    });
    h = await startHarness({}, { llm: model });
    const t = await tenant();

    const running = await startRun(t, 'please wait');
    await until(() => model.calls >= 1);
    await as(t.u1).post(`/runs/${running}/cancel`).expect(202);
    expect((await waitFor(t.u1, running, 'cancelled', 'failed')).status).toBe('cancelled');

    const waiting = await startRun(t);
    const paused = await waitFor(t.u1, waiting, 'waiting_for_approval');
    await as(t.u1).post(`/runs/${waiting}/cancel`).expect(202);
    expect((await waitFor(t.u1, waiting, 'cancelled')).status).toBe('cancelled');
    await as(t.u2)
      .post(`/approvals/${paused.approvalId ?? ''}/approve`)
      .send({})
      .expect(409);
    await as(t.u1).post(`/runs/${waiting}/cancel`).expect(409); // already ended
    expect(refunds).toHaveLength(0);
  }, 60_000);

  it('a leg that keeps failing is retried, then dead-lettered, and the run is marked failed', async () => {
    const model = new ScriptModel(() => new Error('model server down'));
    h = await startHarness({}, { llm: model });
    const t = await tenant();
    const runId = await startRun(t);
    const done = await waitFor(t.u1, runId, 'failed', 'completed');
    expect(done.error).toContain('not retried again');
    expect(model.calls).toBe(3); // attempts: 3
  }, 60_000);
});
