/**
 * Step 4.3 acceptance, through the HTTP API, on real MongoDB (checkpoints in MongoSaver).
 * REQUIRED tests (BUILD_PLAN section 4):
 * - approvals: no write executes before approval, and resuming never executes the same write
 *   twice (two approvers racing, and a second approval after an API restart);
 * - idempotency at the approval level: one card, one decision, one write;
 * - tenant isolation: another tenant cannot see, approve or reject a run or its card.
 * Also: self-approval of a high-risk action is refused, reject runs nothing, a run left
 * `running` by a stopped process is marked failed on startup, and (Step 4.10) every write can be
 * traced in the audit log to a person and an approval, while other tenants see none of it, and
 * (Step 4.3b, required: deny by default) a spec without a policy offers and runs no tools.
 *
 * A scripted model stands in for the LLM (decides from the conversation, so it works across
 * restarts), and a local fake API stands in for the host store and counts every refund it gets.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostPolicy,
  hostSpec,
  startHarness,
} from './harness.js';

const TOKEN = 'runs-e2e-token';

/**
 * A model that reads the conversation: after a user message it asks for one refund (amount and
 * order taken from the message, for example "refund ORD-7 32893"); after a tool result it answers
 * with that result, so tests can see exactly what the model was told.
 */
class RefundModel implements LLMProvider {
  private calls = 0;
  /** The tool names offered on each model call, in order. */
  readonly offered: string[][] = [];

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.offered.push((request.tools ?? []).map((t) => t.name));
    const last = request.messages.at(-1);
    if (last?.role === 'tool') {
      return Promise.resolve({
        message: { role: 'assistant', content: `final: ${last.content}`, toolCalls: [] },
        finishReason: 'stop',
      });
    }
    const [, orderId = '', amount = '0'] = /refund (\S+) (\d+)/.exec(last?.content ?? '') ?? [];
    this.calls++;
    return Promise.resolve({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: `call-${String(this.calls)}`,
            name: 'refunds_request',
            arguments: JSON.stringify({ orderId, amountCents: Number(amount), reason: 'damaged' }),
          },
        ],
      },
      finishReason: 'tool_calls',
    });
  }

  /** The same answer as a stream, using FakeProvider's event order. */
  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(request)]).stream(request);
  }
}

let h: Harness;
let upstream: Server;
let baseUrl: string;
/** Every refund the fake host API received: the thing that must never happen twice. */
const refunds: string[] = [];

/** The fake host API: POST /refunds records the body and returns a pending refund. */
function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end(JSON.stringify({ message: 'no token' }));
      } else if (req.method === 'POST' && req.url === '/refunds') {
        refunds.push(raw);
        res
          .writeHead(201)
          .end(JSON.stringify({ id: `r${String(refunds.length)}`, status: 'pending' }));
      } else {
        res.writeHead(404).end(JSON.stringify({ message: 'not found' }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      resolve(server);
    }),
  );
}

const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${key}`),
});

interface RunView {
  id: string;
  status: string;
  approvalId: string | null;
  answer: string | null;
  error: string | null;
  credentialMode: string;
  principal: { userId: string; role: string };
}
interface AuditRow {
  id: string;
  phase: string;
  runId: string | null;
  status: string | null;
  approval: { id: string } | null;
}
interface CardView {
  id: string;
  runId: string;
  status: string;
  level: string;
  requesterId: string;
  approverId: string | null;
  calls: { name: string; arguments: string; level: string }[];
}

/**
 * A tenant with the host spec, a connection to the fake API, refunds_request enabled and (unless
 * `withPolicy` is false) the host store's role policy uploaded for the spec.
 */
async function tenantWithSpec(
  name: string,
  withPolicy = true,
): Promise<{ key: string; id: string; specId: string }> {
  const tenant = await createTenant(h.http, name);
  const spec = await as(tenant.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await as(tenant.key)
    .put(`/specs/${specId}/connection`)
    .send({ baseUrl, authKind: 'static', secrets: { bearer: TOKEN } })
    .expect(200);
  await as(tenant.key)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .send({ enabled: true })
    .expect(200);
  if (withPolicy) {
    await as(tenant.key).put(`/specs/${specId}/policy`).send({ policy: hostPolicy() }).expect(200);
  }
  return { ...tenant, specId };
}

/** Polls a run until it reaches `status` (runs execute in the background). */
async function waitFor(key: string, runId: string, status: string): Promise<RunView> {
  for (let i = 0; i < 200; i++) {
    const run = body<RunView>(await as(key).get(`/runs/${runId}`).expect(200));
    if (run.status === status) return run;
    if (run.status === 'failed') throw new Error(`run failed: ${run.error ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

/** Starts a refund run for user u1 (support) and waits until it is paused on its card. */
async function pausedRefund(
  tenant: { key: string; specId: string },
  message = 'refund ORD-7 32893',
): Promise<{ run: RunView; card: CardView }> {
  const started = await as(tenant.key)
    .post('/runs')
    .send({ specId: tenant.specId, message, principal: { userId: 'u1', role: 'support' } })
    .expect(202);
  const run = await waitFor(
    tenant.key,
    body<{ runId: string }>(started).runId,
    'waiting_for_approval',
  );
  const cards = body<CardView[]>(await as(tenant.key).get('/approvals?status=pending').expect(200));
  const card = cards.find((c) => c.runId === run.id);
  if (!card) throw new Error('no card for the paused run');
  return { run, card };
}

let model: RefundModel;
let alice: { key: string; id: string; specId: string };
let bob: { key: string; id: string; specId: string };

beforeAll(async () => {
  upstream = await startUpstream();
  baseUrl = `http://localhost:${String((upstream.address() as AddressInfo).port)}`;
  model = new RefundModel();
  h = await startHarness({}, { llm: model });
  alice = await tenantWithSpec('Alice');
  bob = await tenantWithSpec('Bob');
});

afterAll(async () => {
  await h.app.close();
  upstream.closeAllConnections();
  upstream.close();
});

describe('runs and approvals API', () => {
  it('pauses before the write with the exact call; approving runs it exactly once', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);

    expect(run).toMatchObject({
      credentialMode: 'service',
      principal: { userId: 'u1', role: 'support' },
      approvalId: card.id,
    });
    expect(card).toMatchObject({ status: 'pending', level: 'high', requesterId: 'u1' });
    expect(card.calls).toHaveLength(1);
    expect(card.calls[0]?.name).toBe('refunds_request');
    expect(JSON.parse(card.calls[0]?.arguments ?? '{}')).toEqual({
      orderId: 'ORD-7',
      amountCents: 32893,
      reason: 'damaged',
    });
    expect(refunds.length - before).toBe(0); // nothing ran before approval

    const decided = await as(alice.key)
      .post(`/approvals/${card.id}/approve`)
      .send({ approverId: 'u2', reason: 'checked the photos' })
      .expect(202);
    expect(body<{ approval: CardView }>(decided).approval).toMatchObject({
      status: 'approved',
      approverId: 'u2',
    });
    const done = await waitFor(alice.key, run.id, 'completed');
    expect(refunds.length - before).toBe(1);
    expect(done.answer).toContain('pending'); // the model saw the API's answer

    // The card is decided for good: approving again is refused and runs nothing.
    await as(alice.key)
      .post(`/approvals/${card.id}/approve`)
      .send({ approverId: 'u3' })
      .expect(409);
    expect(refunds.length - before).toBe(1);

    // Step 4.10: the write is traced to the requester, the approver and the card, and its
    // arguments hash matches the arguments the approver saw.
    const audit = body<AuditRow[]>(
      await as(alice.key).get(`/audit?runId=${run.id}&safety=write`).expect(200),
    );
    expect(audit.map((r) => r.phase)).toEqual(['finished', 'started']);
    const sha = createHash('sha256')
      .update(card.calls[0]?.arguments ?? '')
      .digest('hex');
    for (const row of audit) {
      expect(row).toMatchObject({
        toolName: 'refunds_request',
        actor: { kind: 'user', userId: 'u1', role: 'support' },
        credentialMode: 'service',
        policyVersion: 1,
        argsHash: sha,
        approval: { id: card.id, level: 'high', requesterId: 'u1', approverId: 'u2' },
      });
    }
    expect(audit[0]).toMatchObject({ status: 'ok' });
    const byCard = body<AuditRow[]>(
      await as(alice.key).get(`/audit?approvalId=${card.id}`).expect(200),
    );
    expect(byCard.map((r) => r.id).sort()).toEqual(audit.map((r) => r.id).sort());
    // Another tenant sees none of it.
    expect(body<AuditRow[]>(await as(bob.key).get(`/audit?runId=${run.id}`).expect(200))).toEqual(
      [],
    );
    const bobsAll = body<AuditRow[]>(await as(bob.key).get('/audit?limit=200').expect(200));
    expect(bobsAll.filter((r) => r.runId === run.id)).toEqual([]);
  });

  it('a spec without a policy offers and runs no tools (deny by default)', async () => {
    const carol = await tenantWithSpec('Carol', false);
    await as(carol.key).get(`/specs/${carol.specId}/policy`).expect(404);
    const before = refunds.length;
    const firstCall = model.offered.length;
    const started = await as(carol.key)
      .post('/runs')
      .send({
        specId: carol.specId,
        message: 'refund ORD-7 32893',
        principal: { userId: 'u1', role: 'owner' }, // even the owner role gets nothing
      })
      .expect(202);
    const runId = body<{ runId: string }>(started).runId;
    const done = await waitFor(carol.key, runId, 'completed');

    // Offered nothing on every model call; the refund the model asked for anyway was refused.
    expect(model.offered.slice(firstCall)).toEqual([[], []]);
    expect(done.answer).toContain('not available');
    expect(refunds.length - before).toBe(0);
    expect(body<AuditRow[]>(await as(carol.key).get(`/audit?runId=${runId}`))).toEqual([]);
  });

  it('audits a direct tool call with the API key as the actor and no approval', async () => {
    const before = refunds.length;
    await as(alice.key)
      .post(`/specs/${alice.specId}/tools/refunds_request/call`)
      .send({ arguments: { orderId: 'ORD-8', amountCents: 500, reason: 'damaged' } })
      .expect(200);
    expect(refunds.length - before).toBe(1);
    const [latest] = body<AuditRow[]>(
      await as(alice.key).get('/audit?toolName=refunds_request&limit=1').expect(200),
    );
    expect(latest).toMatchObject({
      phase: 'finished',
      runId: null,
      actor: { kind: 'api_key' },
      approval: null,
      status: 'ok',
    });
  });

  it('two approvers at the same moment: one wins, the write runs once', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);
    const [a, b] = await Promise.all([
      as(alice.key).post(`/approvals/${card.id}/approve`).send({ approverId: 'u2' }),
      as(alice.key).post(`/approvals/${card.id}/approve`).send({ approverId: 'u3' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await waitFor(alice.key, run.id, 'completed');
    expect(refunds.length - before).toBe(1);
  });

  it('refuses self-approval of a high-risk action; the card stays pending', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);
    await as(alice.key)
      .post(`/approvals/${card.id}/approve`)
      .send({ approverId: 'u1' })
      .expect(403);
    const after = body<RunView>(await as(alice.key).get(`/runs/${run.id}`).expect(200));
    expect(after.status).toBe('waiting_for_approval');
    const pending = body<CardView[]>(await as(alice.key).get('/approvals?status=pending'));
    expect(pending.map((c) => c.id)).toContain(card.id);
    expect(refunds.length - before).toBe(0);

    // Clean up for later tests: someone else rejects it.
    await as(alice.key).post(`/approvals/${card.id}/reject`).send({ approverId: 'u2' }).expect(202);
    await waitFor(alice.key, run.id, 'completed');
  });

  it('rejecting runs nothing and tells the model why', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);
    await as(alice.key)
      .post(`/approvals/${card.id}/reject`)
      .send({ approverId: 'u2', reason: 'amount too high' })
      .expect(202);
    const done = await waitFor(alice.key, run.id, 'completed');
    expect(done.answer).toBe('final: Not run: rejected by u2: amount too high');
    expect(refunds.length - before).toBe(0);
  });

  it('another tenant cannot see, approve or reject a run or its card (404, nothing runs)', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);
    await as(bob.key).get(`/runs/${run.id}`).expect(404);
    await as(bob.key).post(`/approvals/${card.id}/approve`).send({ approverId: 'u2' }).expect(404);
    await as(bob.key).post(`/approvals/${card.id}/reject`).send({ approverId: 'u2' }).expect(404);
    const bobs = body<CardView[]>(await as(bob.key).get('/approvals').expect(200));
    expect(bobs.map((c) => c.id)).not.toContain(card.id);
    // A run on another tenant's spec is refused too.
    await as(bob.key)
      .post('/runs')
      .send({
        specId: alice.specId,
        message: 'refund ORD-7 1',
        principal: { userId: 'u1', role: 'support' },
      })
      .expect(404);
    expect(refunds.length - before).toBe(0);

    await as(alice.key).post(`/approvals/${card.id}/reject`).send({ approverId: 'u2' }).expect(202);
    await waitFor(alice.key, run.id, 'completed');
  });

  it('survives an API restart: approve after restart runs the write once; a second approval does not', async () => {
    const before = refunds.length;
    const { run, card } = await pausedRefund(alice);

    // A run the old process was still executing when it died (written straight to the database).
    const connection = await mongoose
      .createConnection(h.config.MONGO_URI, { dbName: h.config.PLATFORM_MONGO_DB })
      .asPromise();
    const now = new Date();
    await connection.collection('runs').insertOne({
      _id: 'interrupted-run' as never,
      tenantId: new mongoose.Types.ObjectId(alice.id),
      specId: new mongoose.Types.ObjectId(alice.specId),
      message: 'refund ORD-9 100',
      principal: { userId: 'u1', role: 'support' },
      credentialMode: 'service',
      status: 'running',
      approvalId: null,
      answer: null,
      stopReason: null,
      usage: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    await connection.close();

    // Restart: a new app (new MongoDB connection, new checkpointer, new model) on the same data.
    await h.app.close();
    h = await startHarness({}, { keepDatabase: true, llm: new RefundModel() });

    const interrupted = body<RunView>(await as(alice.key).get('/runs/interrupted-run').expect(200));
    expect(interrupted.status).toBe('failed');

    await as(alice.key)
      .post(`/approvals/${card.id}/approve`)
      .send({ approverId: 'u2' })
      .expect(202);
    await waitFor(alice.key, run.id, 'completed');
    expect(refunds.length - before).toBe(1);
    await as(alice.key)
      .post(`/approvals/${card.id}/approve`)
      .send({ approverId: 'u2' })
      .expect(409);
    expect(refunds.length - before).toBe(1);
  });
});
