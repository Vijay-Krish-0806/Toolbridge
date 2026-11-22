/**
 * Step 4.4c acceptance: user delegation.
 * - Done check: owner and warehouse users get different results for the same request, with the
 *   HOST enforcing its own rules (ToolBridge's policy allows both), and service mode still works
 *   (the other e2e suites run in service mode).
 * - REQUIRED (RBAC: a call must be allowed by ToolBridge and by the host): the host's refusal
 *   stands; nothing falls back to the service credential.
 * - An approved write runs with the APPROVER's own token (ADR 0028); an approver without the host
 *   permission makes it fail safely; a requester who logged out cannot have calls made for them.
 * - REQUIRED (encryption): a host token copied into another session's record does not decrypt.
 * The fake host API knows one token per user and records every Authorization header it gets.
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

/** The tenant's stored service credential: must never reach the host in delegated mode. */
const SERVICE_TOKEN = 'svc-token-never-in-delegated-runs';
/** Host users and their host tokens. Only the owner and the lead may file refunds AT THE HOST. */
const HOST_USERS: Record<string, { role: string; mayRefund: boolean }> = {
  'tok-owner': { role: 'owner', mayRefund: true },
  'tok-warehouse': { role: 'warehouse', mayRefund: false },
  'tok-support': { role: 'support', mayRefund: false },
  'tok-lead': { role: 'support', mayRefund: true },
};

let upstream: Server;
let baseUrl: string;
/** Every Authorization header the host received, and each refund it filed (by token). */
const seenAuth: string[] = [];
const filedBy: string[] = [];

/** The fake host: refunds need a token whose user may refund; reads need any known token. */
function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      seenAuth.push(auth);
      const token = auth.replace(/^Bearer /, '');
      const user = HOST_USERS[token];
      res.setHeader('content-type', 'application/json');
      if (token === SERVICE_TOKEN) {
        res.writeHead(200).end(JSON.stringify({ via: 'service' }));
      } else if (!user) {
        res.writeHead(401).end(JSON.stringify({ message: 'unknown token' }));
      } else if (req.method === 'POST' && req.url === '/refunds') {
        if (!user.mayRefund) {
          res.writeHead(403).end(JSON.stringify({ message: `role ${user.role} may not refund` }));
          return;
        }
        filedBy.push(token);
        res
          .writeHead(201)
          .end(JSON.stringify({ id: `r${String(filedBy.length)}`, status: 'pending' }));
      } else if (req.url?.startsWith('/orders/by-number/')) {
        res.end(JSON.stringify({ number: 'ORD-7', status: 'paid' }));
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      resolve(server);
    }),
  );
}

/**
 * A model that reads the conversation: "refund X N" -> one refund call; after a rejected card
 * -> one order lookup; after any other tool result -> a final answer quoting that result.
 */
class DelegationModel implements LLMProvider {
  private calls = 0;
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls++;
    const last = req.messages.at(-1);
    const user = req.messages.findLast((m) => m.role === 'user')?.content ?? '';
    const tool = (name: string, args: Record<string, unknown>): GenerateResult => ({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${String(this.calls)}`, name, arguments: JSON.stringify(args) }],
      },
      finishReason: 'tool_calls',
    });
    if (last?.role === 'tool' && last.content.startsWith('Not run: rejected')) {
      return Promise.resolve(tool('orders_get', { number: 'ORD-7' }));
    }
    if (last?.role === 'tool') {
      return Promise.resolve({
        message: { role: 'assistant', content: `final: ${last.content}`, toolCalls: [] },
        finishReason: 'stop',
      });
    }
    const [, orderId = 'ORD-7', amount = '500'] = /refund (\S+) (\d+)/.exec(user) ?? [];
    return Promise.resolve(
      tool('refunds_request', { orderId, amountCents: Number(amount), reason: 'damaged' }),
    );
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
  del: (path: string) => request(h.http).delete(path).set('authorization', `Bearer ${token}`),
});

interface RunView {
  status: string;
  answer: string | null;
  approvalId: string | null;
  credentialMode: string;
}
interface AuditRow {
  phase: string;
  toolName: string;
  status: string | null;
  credentialMode: string;
  credentialUserId: string | null;
  approval: { requesterId: string; approverId: string } | null;
}

/** A tenant in DELEGATED mode with the host spec (service key stored) and `policy`. */
async function delegatedTenant(name: string, policy: Record<string, unknown>) {
  const tenant = await createTenant(h.http, name);
  const spec = await as(tenant.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await as(tenant.key)
    .put(`/specs/${specId}/connection`)
    .send({ baseUrl, authKind: 'static', secrets: { bearer: SERVICE_TOKEN } })
    .expect(200);
  await as(tenant.key)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .send({ enabled: true })
    .expect(200);
  await as(tenant.key).put(`/specs/${specId}/policy`).send({ policy }).expect(200);
  await as(tenant.key).put('/tenant/credential-mode').send({ mode: 'delegated' }).expect(200);
  return { key: tenant.key, specId };
}

/** The host's backend minting a session for one of its users, with that user's host token. */
async function session(
  t: { key: string; specId: string },
  userId: string,
  role: string,
  userToken?: string,
) {
  const response = await as(t.key)
    .post('/sessions')
    .send({ specId: t.specId, userId, role, ...(userToken && { userToken }) })
    .expect(201);
  return body<{ token: string }>(response).token;
}

async function waitFor(token: string, runId: string, ...statuses: string[]): Promise<RunView> {
  for (let i = 0; i < 200; i++) {
    const run = body<RunView>(await as(token).get(`/runs/${runId}`).expect(200));
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run never reached ${statuses.join('/')}`);
}

async function run(token: string, message: string): Promise<string> {
  const started = await as(token).post('/runs').send({ message }).expect(202);
  return body<{ runId: string }>(started).runId;
}

/** ToolBridge lets every role request refunds without approval: the HOST alone decides. */
const OPEN_POLICY = {
  version: 1,
  roles: { owner: { allow: ['*'] }, warehouse: { allow: ['*'] }, support: { allow: ['*'] } },
  approvals: { default: 'none', rules: [] },
};

beforeAll(async () => {
  upstream = await startUpstream();
  baseUrl = `http://localhost:${String((upstream.address() as AddressInfo).port)}`;
  h = await startHarness({}, { llm: new DelegationModel() });
});

afterAll(async () => {
  await h.stop();
  upstream.closeAllConnections();
  upstream.close();
});

describe('user delegation', () => {
  it('the same request: the owner gets a refund, warehouse gets the host 403 (host rules apply)', async () => {
    const t = await delegatedTenant('Open', OPEN_POLICY);
    const owner = await session(t, 'alice', 'owner', 'tok-owner');
    const warehouse = await session(t, 'bob', 'warehouse', 'tok-warehouse');
    const before = filedBy.length;

    const ownerRun = await run(owner, 'refund ORD-7 500');
    const ownerDone = await waitFor(owner, ownerRun, 'completed', 'failed');
    expect(ownerDone.credentialMode).toBe('delegated');
    expect(ownerDone.answer).toContain('pending');
    expect(filedBy.slice(before)).toEqual(['tok-owner']);

    const warehouseRun = await run(warehouse, 'refund ORD-7 500');
    const warehouseDone = await waitFor(warehouse, warehouseRun, 'completed', 'failed');
    expect(warehouseDone.answer).toContain('403');
    expect(warehouseDone.answer).toContain('may not refund');
    expect(filedBy.slice(before)).toEqual(['tok-owner']); // nothing filed for warehouse

    const audit = body<AuditRow[]>(
      await as(t.key).get(`/audit?toolName=refunds_request&safety=write`).expect(200),
    ).filter((r) => r.phase === 'finished');
    expect(audit.map((r) => [r.credentialMode, r.credentialUserId, r.status])).toEqual([
      ['delegated', 'bob', 'http_error'],
      ['delegated', 'alice', 'ok'],
    ]);
    expect(seenAuth).not.toContain(`Bearer ${SERVICE_TOKEN}`);
  });

  it("an approved write runs with the APPROVER's token; the audit names requester and approver", async () => {
    const t = await delegatedTenant('Cards', hostPolicy());
    const requester = await session(t, 'sam', 'support', 'tok-support'); // the host refuses sam
    const lead = await session(t, 'lee', 'support', 'tok-lead'); // the host allows lee
    const before = filedBy.length;
    const runId = await run(requester, 'refund ORD-7 32893'); // high risk: needs a card
    const paused = await waitFor(requester, runId, 'waiting_for_approval');
    expect(filedBy.length - before).toBe(0);

    await as(lead)
      .post(`/approvals/${paused.approvalId ?? ''}/approve`)
      .send({})
      .expect(202);
    const done = await waitFor(requester, runId, 'completed', 'failed');
    expect(done.answer).toContain('pending');
    expect(filedBy.slice(before)).toEqual(['tok-lead']);

    const [row] = body<AuditRow[]>(
      await as(t.key).get(`/audit?runId=${runId}&safety=write`).expect(200),
    );
    expect(row).toMatchObject({
      status: 'ok',
      credentialMode: 'delegated',
      credentialUserId: 'lee',
      approval: { requesterId: 'sam', approverId: 'lee' },
    });
    expect(seenAuth).not.toContain(`Bearer ${SERVICE_TOKEN}`);
  });

  it('an approver without the host permission: the write fails safely, no other identity is tried', async () => {
    const t = await delegatedTenant('NoPerm', hostPolicy());
    const requester = await session(t, 'sam', 'support', 'tok-lead');
    const approver = await session(t, 'pat', 'support', 'tok-support'); // host: may not refund
    const before = filedBy.length;
    const authBefore = seenAuth.length;
    const runId = await run(requester, 'refund ORD-7 32893');
    const paused = await waitFor(requester, runId, 'waiting_for_approval');
    await as(approver)
      .post(`/approvals/${paused.approvalId ?? ''}/approve`)
      .send({})
      .expect(202);
    const done = await waitFor(requester, runId, 'completed', 'failed');

    expect(done.answer).toContain('may not refund');
    expect(filedBy.length - before).toBe(0);
    // One attempt, with the approver's token: not the requester's, not the service key.
    expect(seenAuth.slice(authBefore)).toEqual(['Bearer tok-support']);
  });

  it('a requester who logged out: their next call is refused, never run as someone else', async () => {
    const t = await delegatedTenant('Logout', hostPolicy());
    const requester = await session(t, 'sam', 'support', 'tok-support');
    const lead = await session(t, 'lee', 'support', 'tok-lead');
    const authBefore = seenAuth.length;
    const runId = await run(requester, 'refund ORD-7 32893');
    const paused = await waitFor(requester, runId, 'waiting_for_approval');

    await as(requester).del('/sessions/current').expect(200);
    // Rejected, so the model looks the order up instead: that call would use sam's token.
    await as(lead)
      .post(`/approvals/${paused.approvalId ?? ''}/reject`)
      .send({})
      .expect(202);
    const sessionForReading = await session(t, 'sam', 'support', 'tok-support');
    const done = await waitFor(sessionForReading, runId, 'completed', 'failed');

    expect(done.answer).toContain("The user's session has ended");
    expect(seenAuth.slice(authBefore)).toEqual([]); // nothing was sent to the host at all
    const rows = body<AuditRow[]>(await as(t.key).get(`/audit?runId=${runId}`).expect(200));
    expect(rows.map((r) => [r.toolName, r.status])).toEqual([
      ['orders_get', 'credential_unavailable'],
    ]);
  });

  it('delegated mode needs host tokens: no session without one, no approval without one', async () => {
    const t = await delegatedTenant('Rules', hostPolicy());
    await as(t.key)
      .post('/sessions')
      .send({ specId: t.specId, userId: 'u1', role: 'support' })
      .expect(422);

    // An approver session minted while the tenant was still in service mode carries no token.
    await as(t.key).put('/tenant/credential-mode').send({ mode: 'service' }).expect(200);
    const tokenless = await session(t, 'pat', 'support');
    await as(t.key).put('/tenant/credential-mode').send({ mode: 'delegated' }).expect(200);
    const requester = await session(t, 'sam', 'support', 'tok-lead');
    const runId = await run(requester, 'refund ORD-7 32893');
    const paused = await waitFor(requester, runId, 'waiting_for_approval');
    await as(tokenless)
      .post(`/approvals/${paused.approvalId ?? ''}/approve`)
      .send({})
      .expect(422);
  });

  it("a host token copied into another session's record does not decrypt (AAD binding)", async () => {
    const t = await delegatedTenant('Aad', hostPolicy());
    await session(t, 'alice', 'support', 'tok-lead');
    const victim = await session(t, 'mallory', 'support', 'tok-support');
    const connection = await mongoose
      .createConnection(h.config.MONGO_URI, { dbName: h.config.PLATFORM_MONGO_DB })
      .asPromise();
    try {
      const sessions = connection.collection('sessions');
      const alice = await sessions.findOne({ userId: 'alice' });
      await sessions.updateOne({ userId: 'mallory' }, { $set: { userToken: alice?.userToken } });
    } finally {
      await connection.close();
    }
    // Mallory's session now holds Alice's ciphertext: it is unusable, so the run is refused.
    await as(victim).post('/runs').send({ message: 'refund ORD-7 500' }).expect(422);
  });
});
