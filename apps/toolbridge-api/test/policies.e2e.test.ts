/**
 * Step 4.3b acceptance: role policies stored per spec.
 * REQUIRED (tenant isolation): one tenant cannot read, replace or list another tenant's policy.
 * Also pins the storage rules: every upload is a new immutable version, an invalid policy is
 * refused, names the spec lacks come back as warnings, and a policy written for an older spec
 * version is marked stale. (The "no policy means no tools" run test is in runs.e2e.test.ts.)
 */
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

let h: Harness;

const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${key}`),
});

interface SetResult {
  version: number;
  specVersion: number;
  policyHash: string;
  warnings: string[];
}
interface Current extends SetResult {
  policy: { roles: Record<string, unknown> };
  currentSpecVersion: number;
  stale: boolean;
}

/** A tenant with the host spec registered; returns its key and spec id. */
async function tenantWithSpec(name: string): Promise<{ key: string; specId: string }> {
  const tenant = await createTenant(h.http, name);
  const response = await as(tenant.key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  return { key: tenant.key, specId: body<{ spec: { id: string } }>(response).spec.id };
}

let alice: { key: string; specId: string };
let bob: { key: string; specId: string };

beforeAll(async () => {
  h = await startHarness();
  alice = await tenantWithSpec('Alice');
  bob = await tenantWithSpec('Bob');
});

afterAll(async () => {
  await h.app.close();
});

describe('policy per spec', () => {
  it('has no policy at first: 404 that says every tool is denied', async () => {
    const response = await as(alice.key).get(`/specs/${alice.specId}/policy`).expect(404);
    expect(body<{ message: string }>(response).message).toContain('every tool is denied');
  });

  it('stores each upload as a new version and keeps the history', async () => {
    const first = body<SetResult>(
      await as(alice.key)
        .put(`/specs/${alice.specId}/policy`)
        .send({ policy: hostPolicy() })
        .expect(200),
    );
    expect(first).toMatchObject({ version: 1, specVersion: 1 });
    // knowledge_search is the chat CLI's built-in tool, not an API operation, so the spec lacks it.
    expect(first.warnings).toEqual([
      'roles.support.allow: no tool named "knowledge_search" in spec version 1.',
      'roles.warehouse.allow: no tool named "knowledge_search" in spec version 1.',
    ]);

    const tighter = { version: 1, roles: { owner: { allow: ['*'] } } };
    const second = body<SetResult>(
      await as(alice.key)
        .put(`/specs/${alice.specId}/policy`)
        .send({ policy: tighter })
        .expect(200),
    );
    expect(second.version).toBe(2);
    expect(second.policyHash).not.toBe(first.policyHash);

    const current = body<Current>(
      await as(alice.key).get(`/specs/${alice.specId}/policy`).expect(200),
    );
    expect(current).toMatchObject({ version: 2, stale: false });
    expect(Object.keys(current.policy.roles)).toEqual(['owner']);
    const history = body<SetResult[]>(
      await as(alice.key).get(`/specs/${alice.specId}/policy/versions`).expect(200),
    );
    expect(history.map((v) => [v.version, v.policyHash])).toEqual([
      [2, second.policyHash],
      [1, first.policyHash],
    ]);
  });

  it('refuses an invalid policy (422) and stores nothing', async () => {
    await as(alice.key)
      .put(`/specs/${alice.specId}/policy`)
      .send({ policy: { version: 1, roles: { support: { allow: ['orders.*'] } } } })
      .expect(422);
    const history = body<SetResult[]>(
      await as(alice.key).get(`/specs/${alice.specId}/policy/versions`),
    );
    expect(history).toHaveLength(2);
  });

  it('warns about names the spec does not have', async () => {
    const policy = { version: 1, roles: { support: { allow: ['refunds_reqest', 'invoices_*'] } } };
    const result = body<SetResult>(
      await as(alice.key).put(`/specs/${alice.specId}/policy`).send({ policy }).expect(200),
    );
    expect(result.warnings).toEqual([
      'roles.support.allow: no tool named "refunds_reqest" in spec version 1.',
      'roles.support.allow: "invoices_*" matches no tool in spec version 1.',
    ]);
  });

  it('carries the policy forward to a new spec version and marks it stale', async () => {
    await as(alice.key)
      .post(`/specs/${alice.specId}/versions`)
      .send({ document: hostSpec(), overrides: hostOverrides() })
      .expect(201);
    const current = body<Current>(
      await as(alice.key).get(`/specs/${alice.specId}/policy`).expect(200),
    );
    expect(current).toMatchObject({
      version: 3,
      specVersion: 1,
      currentSpecVersion: 2,
      stale: true,
    });
  });

  it("another tenant cannot read, replace or list a tenant's policy (404)", async () => {
    await as(bob.key).get(`/specs/${alice.specId}/policy`).expect(404);
    await as(bob.key).get(`/specs/${alice.specId}/policy/versions`).expect(404);
    await as(bob.key)
      .put(`/specs/${alice.specId}/policy`)
      .send({ policy: { version: 1, roles: { owner: { allow: ['*'] } } } })
      .expect(404);
    // Alice's policy is unchanged, and Bob's own spec still has none.
    const current = body<Current>(
      await as(alice.key).get(`/specs/${alice.specId}/policy`).expect(200),
    );
    expect(current.version).toBe(3);
    await as(bob.key).get(`/specs/${bob.specId}/policy`).expect(404);
  });
});
