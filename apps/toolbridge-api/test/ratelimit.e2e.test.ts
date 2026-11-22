/**
 * Step 4.5: per-tenant rate limits on real Redis (a token bucket in one Lua script). A tenant that
 * starts runs too fast gets 429 with Retry-After and nothing is created; another tenant is not
 * affected; the bucket refills with time.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

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

let h: Harness | undefined;

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A tenant whose spec can start runs (connection and policy set), and a session for u1. */
async function tenant(harness: Harness, name: string): Promise<string> {
  const t = await createTenant(harness.http, name);
  const auth = { authorization: `Bearer ${t.key}` };
  const spec = await request(harness.http)
    .post('/specs')
    .set(auth)
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await request(harness.http)
    .put(`/specs/${specId}/connection`)
    .set(auth)
    .send({ baseUrl: 'http://localhost:9', authKind: 'static', secrets: { bearer: 'x' } })
    .expect(200);
  await request(harness.http)
    .put(`/specs/${specId}/policy`)
    .set(auth)
    .send({ policy: hostPolicy() })
    .expect(200);
  return mintSession(harness.http, t.key, specId, 'u1');
}

const startRun = (harness: Harness, token: string) =>
  request(harness.http)
    .post('/runs')
    .set('authorization', `Bearer ${token}`)
    .send({ message: 'hello' });

describe('per-tenant rate limits', () => {
  it('refuses runs over the limit with 429 and Retry-After; another tenant is unaffected', async () => {
    h = await startHarness({ RATE_RUNS_PER_MINUTE: '2' });
    const a = await tenant(h, 'Fast');
    const b = await tenant(h, 'Calm');
    await startRun(h, a).expect(202);
    await startRun(h, a).expect(202);
    const refused = await startRun(h, a).expect(429);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(31); // 2 per minute: a token every 30 s
    await startRun(h, b).expect(202);
  });

  it('refills with time', async () => {
    h = await startHarness({ RATE_RUNS_PER_MINUTE: '60' }); // one token per second
    const a = await tenant(h, 'Burst');
    let status = 202;
    for (let i = 0; i < 100 && status === 202; i++) status = (await startRun(h, a)).status;
    expect(status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await startRun(h, a).expect(202);
  });
});
