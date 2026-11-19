/**
 * Step 2.6a acceptance test: two tenants cannot see or touch each other's specs, tools or keys,
 * even with the other tenant's ids in hand (IDOR). Plus the key rules: admin and tenant keys are
 * not interchangeable, keys can be rotated and revoked, and the last key cannot be revoked.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN_KEY,
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostSpec,
  startHarness,
} from './harness.js';

interface Tool {
  name: string;
  enabled: boolean;
  status: string;
  safety: string;
}

let h: Harness;
let alice: { id: string; key: string };
let bob: { id: string; key: string };
let aliceSpecId: string;
let bobSpecId: string;

/** Sends a request as a tenant (or with any bearer token). */
const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${key}`),
  delete: (path: string) => request(h.http).delete(path).set('authorization', `Bearer ${key}`),
});

beforeAll(async () => {
  h = await startHarness();
  alice = await createTenant(h.http, 'Alice Shop');
  bob = await createTenant(h.http, 'Bob Store');
  const a = await as(alice.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const b = await as(bob.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  aliceSpecId = body<{ spec: { id: string } }>(a).spec.id;
  bobSpecId = body<{ spec: { id: string } }>(b).spec.id;
});

afterAll(async () => {
  await h.app.close();
});

describe('keys', () => {
  it('rejects missing, malformed and forged keys with the same 401', async () => {
    const forged = `tb_${'0'.repeat(16)}_${'A'.repeat(43)}`;
    for (const auth of [undefined, 'Bearer nope', `Bearer ${forged}`]) {
      const req = request(h.http).get('/specs');
      const response = await (auth ? req.set('authorization', auth) : req).expect(401);
      expect(body<{ message: string }>(response).message).toBe(
        'Missing, invalid or revoked API key.',
      );
    }
  });

  it('never accepts the admin key as a tenant key, or a tenant key as the admin key', async () => {
    await as(ADMIN_KEY).get('/specs').expect(401);
    await as(alice.key).post('/admin/tenants').send({ name: 'Mallory' }).expect(401);
    await as(`${ADMIN_KEY}x`).post('/admin/tenants').send({ name: 'Mallory' }).expect(401);
  });

  it('identifies the caller only from its key', async () => {
    const me = body<{ id: string; name: string }>(await as(alice.key).get('/me').expect(200));
    expect(me).toEqual({ id: alice.id, name: 'Alice Shop' });
  });
});

describe('two tenants cannot see each other', () => {
  it('lists only their own specs, even with the same spec name', async () => {
    const aliceList = body<{ id: string }[]>(await as(alice.key).get('/specs').expect(200));
    const bobList = body<{ id: string }[]>(await as(bob.key).get('/specs').expect(200));
    expect(aliceList.map((s) => s.id)).toEqual([aliceSpecId]);
    expect(bobList.map((s) => s.id)).toEqual([bobSpecId]);
  });

  it("gets 404 (not 403) for every route on the other tenant's spec id (IDOR)", async () => {
    await as(bob.key).get(`/specs/${aliceSpecId}`).expect(404);
    await as(bob.key).get(`/specs/${aliceSpecId}/tools`).expect(404);
    await as(bob.key)
      .patch(`/specs/${aliceSpecId}/tools/orders_list`)
      .send({ enabled: false })
      .expect(404);
    await as(bob.key)
      .post(`/specs/${aliceSpecId}/versions`)
      .send({ document: hostSpec() })
      .expect(404);
    await as(bob.key).get('/specs/not-an-id').expect(404);
    await as(bob.key).get('/specs/000000000000000000000000').expect(404);
  });

  it("cannot see or revoke the other tenant's API keys", async () => {
    const aliceKeys = body<{ keyId: string }[]>(await as(alice.key).get('/api-keys').expect(200));
    const bobKeys = body<{ keyId: string }[]>(await as(bob.key).get('/api-keys').expect(200));
    expect(aliceKeys.map((k) => k.keyId)).not.toContain(bobKeys[0]?.keyId);
    await as(bob.key)
      .delete(`/api-keys/${aliceKeys[0]?.keyId ?? ''}`)
      .expect(404);
  });

  it("changing one tenant's tool does not change the other's", async () => {
    await as(bob.key)
      .patch(`/specs/${bobSpecId}/tools/orders_list`)
      .send({ enabled: false })
      .expect(200);
    const aliceTools = body<Tool[]>(
      await as(alice.key).get(`/specs/${aliceSpecId}/tools`).expect(200),
    );
    const bobTools = body<Tool[]>(await as(bob.key).get(`/specs/${bobSpecId}/tools`).expect(200));
    expect(aliceTools.find((t) => t.name === 'orders_list')?.enabled).toBe(true);
    expect(bobTools.find((t) => t.name === 'orders_list')?.enabled).toBe(false);
  });

  it('never returns key secrets or hashes', async () => {
    const response = await as(alice.key).get('/api-keys').expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(/secretHash|tb_[a-f0-9]{16}_/);
  });
});

describe('a registered spec', () => {
  it('starts with read tools enabled and write tools disabled (overrides applied: 35 tools)', async () => {
    const tools = body<Tool[]>(await as(alice.key).get(`/specs/${aliceSpecId}/tools`).expect(200));
    expect(tools).toHaveLength(35);
    expect(tools.filter((t) => t.safety === 'read').every((t) => t.enabled)).toBe(true);
    expect(tools.filter((t) => t.safety === 'write').every((t) => !t.enabled)).toBe(true);
  });
});

describe('key rotation and revocation', () => {
  it('a revoked key stops working at once; the last active key cannot be revoked', async () => {
    const carol = await createTenant(h.http, 'Carol');
    const second = body<{ apiKey: string }>(
      await as(carol.key).post('/api-keys').send({ label: 'rotation' }).expect(201),
    ).apiKey;
    const keys = body<{ keyId: string; label: string }[]>(
      await as(second).get('/api-keys').expect(200),
    );
    const initial = keys.find((k) => k.label === 'initial')?.keyId ?? '';
    const rotation = keys.find((k) => k.label === 'rotation')?.keyId ?? '';

    await as(second).delete(`/api-keys/${initial}`).expect(200);
    await as(carol.key).get('/me').expect(401);
    await as(second).get('/me').expect(200);
    await as(second).delete(`/api-keys/${rotation}`).expect(409);
  });
});
