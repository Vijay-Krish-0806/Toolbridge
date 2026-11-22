/**
 * Step 4.6 (b). Two checks that need a real database and HTTP:
 * - REQUIRED (tenant isolation): one tenant's usage and cost are never visible to another, and
 *   never to an end user's session token.
 * - Money: a tenant over its monthly budget cannot start runs (429 `budget_exhausted`), another
 *   tenant is not affected, and a run's cap is the smaller of RUN_MAX_TOKENS and what is left.
 * Usage rows are inserted directly (the worker writes them in production), so the numbers are exact.
 */
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Run, UsageRecord } from '../src/domain/models.js';
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

let h: Harness;

/** A tenant whose spec can start runs, its API key header, and a session token for u1. */
async function tenant(name: string) {
  const t = await createTenant(h.http, name);
  const auth = { authorization: `Bearer ${t.key}` };
  const spec = await request(h.http)
    .post('/specs')
    .set(auth)
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await request(h.http)
    .put(`/specs/${specId}/connection`)
    .set(auth)
    .send({ baseUrl: 'http://localhost:9', authKind: 'static', secrets: { bearer: 'x' } })
    .expect(200);
  await request(h.http)
    .put(`/specs/${specId}/policy`)
    .set(auth)
    .send({ policy: hostPolicy() })
    .expect(200);
  const session = await mintSession(h.http, t.key, specId, 'u1');
  return { id: t.id, auth, session: { authorization: `Bearer ${session}` } };
}

/** Writes one model call's usage row for a tenant, as the worker would. */
async function spend(tenantId: string, runId: string, inputTokens: number, outputTokens: number) {
  const model = h.app.get<Model<UsageRecord>>(getModelToken('UsageRecord'));
  await model.create({
    tenantId: new Types.ObjectId(tenantId),
    runId,
    model: 'fake',
    inputTokens,
    outputTokens,
    costMicroUsd: inputTokens * 3 + outputTokens * 15,
    price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    at: new Date(),
  });
}

/** How many run records a tenant has (there is no list endpoint; read the database). */
const runCount = (tenantId: string) =>
  h.app
    .get<Model<Run>>(getModelToken('Run'))
    .countDocuments({ tenantId: new Types.ObjectId(tenantId) })
    .exec();

const startRun = (session: Record<string, string>) =>
  request(h.http).post('/runs').set(session).send({ message: 'hello' });

let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  h = await startHarness({ RUN_MAX_TOKENS: '60000' });
  a = await tenant('Spender');
  b = await tenant('Other');
  await spend(a.id, 'run-a', 1000, 200);
});

afterAll(async () => {
  await h.stop();
});

describe('usage is per tenant (required: tenant isolation)', () => {
  it("shows a tenant its own use and never another tenant's", async () => {
    const own = await request(h.http).get('/usage').set(a.auth).expect(200);
    expect(own.body).toMatchObject({
      totals: { modelCalls: 1, inputTokens: 1000, outputTokens: 200, costMicroUsd: 6000 },
      byDay: [{ model: 'fake', modelCalls: 1, inputTokens: 1000 }],
      budget: { monthlyTokenBudget: null, usedTokens: 1200, leftTokens: null },
    });
    await request(h.http)
      .get('/usage/runs/run-a')
      .set(a.auth)
      .expect(200, { modelCalls: 1, inputTokens: 1000, outputTokens: 200, costMicroUsd: 6000 });

    const other = await request(h.http).get('/usage').set(b.auth).expect(200);
    expect(other.body).toMatchObject({
      totals: { modelCalls: 0, inputTokens: 0, costMicroUsd: 0 },
      byDay: [],
      budget: { usedTokens: 0 },
    });
    await request(h.http)
      .get('/usage/runs/run-a')
      .set(b.auth)
      .expect(200, { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
  });

  it('refuses end-user session tokens on the usage endpoints', async () => {
    await request(h.http).get('/usage').set(a.session).expect(401);
    await request(h.http).get('/usage/runs/run-a').set(a.session).expect(401);
  });
});

describe('monthly budget', () => {
  it('caps a run at what is left, refuses runs when too little is left, and spares other tenants', async () => {
    // 1,200 used. Budget 1,500 -> 300 left (>= 256): the run starts with a 300-token cap.
    await request(h.http)
      .put('/tenant/budget')
      .set(a.auth)
      .send({ monthlyTokenBudget: 1500 })
      .expect(200);
    const capped = await startRun(a.session).expect(202);
    const run = await request(h.http)
      .get(`/runs/${body<{ runId: string }>(capped).runId}`)
      .set(a.session)
      .expect(200);
    expect(run.body).toMatchObject({ tokenCap: 300 });

    // Budget 1,300 -> 100 left: not enough for one model call.
    await request(h.http)
      .put('/tenant/budget')
      .set(a.auth)
      .send({ monthlyTokenBudget: 1300 })
      .expect(200);
    const before = await runCount(a.id);
    const refused = await startRun(a.session).expect(429);
    expect(refused.body).toMatchObject({ error: 'budget_exhausted' });
    expect(refused.headers['retry-after']).toBeUndefined();
    expect(await runCount(a.id)).toBe(before); // nothing saved or queued

    await startRun(b.session).expect(202);

    // No limit again: the cap is RUN_MAX_TOKENS.
    await request(h.http)
      .put('/tenant/budget')
      .set(a.auth)
      .send({ monthlyTokenBudget: null })
      .expect(200);
    const free = await startRun(a.session).expect(202);
    const freeRun = await request(h.http)
      .get(`/runs/${body<{ runId: string }>(free).runId}`)
      .set(a.session)
      .expect(200);
    expect(freeRun.body).toMatchObject({ tokenCap: 60000 });
  });

  it('rejects invalid budgets', async () => {
    for (const monthlyTokenBudget of [-1, 1.5, '1000', undefined]) {
      await request(h.http)
        .put('/tenant/budget')
        .set(a.auth)
        .send({ monthlyTokenBudget })
        .expect(400);
    }
  });
});
