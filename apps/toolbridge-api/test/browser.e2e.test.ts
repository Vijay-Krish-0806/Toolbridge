/**
 * Step 4.4b session (b) acceptance: the browser side.
 * REQUIRED (BUILD_PLAN section 4): the dev login page is off outside development (404 with
 * PLATFORM_ENV=test and =production, the default).
 * Also: the dev login works in development and applies the same rules as POST /sessions; CORS is
 * per tenant (a preflight only for a known origin; a real request only from an origin the TOKEN's
 * tenant allows); keys are refused from a browser; origins must be bare http(s) origins.
 * Requests carry an `Origin` header to act as a browser (supertest sends none by default).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
  testEnv,
} from './harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A harness with one tenant, its spec and the host policy. */
async function setup(env: Record<string, string> = {}) {
  h = await startHarness(env);
  const tenant = await createTenant(h.http, 'Acme');
  const response = await request(h.http)
    .post('/specs')
    .set('authorization', `Bearer ${tenant.key}`)
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(response).spec.id;
  await request(h.http)
    .put(`/specs/${specId}/policy`)
    .set('authorization', `Bearer ${tenant.key}`)
    .send({ policy: hostPolicy() })
    .expect(200);
  // A connection, so runs can start (they are never executed here: no worker).
  await request(h.http)
    .put(`/specs/${specId}/connection`)
    .set('authorization', `Bearer ${tenant.key}`)
    .send({ baseUrl: 'http://localhost:9', authKind: 'static', secrets: { bearer: 'x' } })
    .expect(200);
  return { http: h.http, tenant, specId };
}

describe('dev login (REQUIRED: off outside development)', () => {
  it.each([['test'], ['production']])('does not exist with PLATFORM_ENV=%s', async (env) => {
    const { http, tenant, specId } = await setup({ PLATFORM_ENV: env });
    await request(http).get('/dev/login').expect(404);
    await request(http)
      .post('/dev/login')
      .send({ apiKey: tenant.key, specId, userId: 'u1', role: 'support' })
      .expect(404);
  });

  it('is off when PLATFORM_ENV is not set at all (the default is production)', async () => {
    const { loadConfig } = await import('../src/config.js');
    const env = testEnv();
    delete env.PLATFORM_ENV;
    expect(loadConfig(env).PLATFORM_ENV).toBe('production');
  });

  it('works in development: serves the page with a CSP and mints by the same rules', async () => {
    const { http, tenant, specId } = await setup({ PLATFORM_ENV: 'development' });
    const page = await request(http).get('/dev/login').expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.text).toContain('Development only');

    const minted = await request(http)
      .post('/dev/login')
      .send({ apiKey: tenant.key, specId, userId: 'dev-user', role: 'support' })
      .expect(201);
    const { token } = body<{ token: string }>(minted);
    await request(http).get('/approvals').set('authorization', `Bearer ${token}`).expect(200);

    await request(http)
      .post('/dev/login')
      .send({ apiKey: 'tb_0000000000000000_wrong', specId, userId: 'u1', role: 'support' })
      .expect(401);
    await request(http)
      .post('/dev/login')
      .send({ apiKey: tenant.key, specId, userId: 'u1', role: 'admin' })
      .expect(422);
  });
});

describe('CORS per tenant', () => {
  const SHOP_A = 'https://shop-a.example';
  const SHOP_B = 'https://shop-b.example';

  /** Two tenants, each allowing its own shop's origin, with a session token each. */
  async function twoShops() {
    const a = await setup();
    const b = await createTenant(a.http, 'Beta');
    const bSpec = await request(a.http)
      .post('/specs')
      .set('authorization', `Bearer ${b.key}`)
      .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
      .expect(201);
    const bSpecId = body<{ spec: { id: string } }>(bSpec).spec.id;
    await request(a.http)
      .put(`/specs/${bSpecId}/policy`)
      .set('authorization', `Bearer ${b.key}`)
      .send({ policy: hostPolicy() })
      .expect(200);
    for (const [key, origin] of [
      [a.tenant.key, SHOP_A],
      [b.key, SHOP_B],
    ] as const) {
      await request(a.http)
        .put('/tenant/origins')
        .set('authorization', `Bearer ${key}`)
        .send({ origins: [origin] })
        .expect(200);
    }
    return {
      http: a.http,
      aKey: a.tenant.key,
      aToken: await mintSession(a.http, a.tenant.key, a.specId, 'u1'),
      bToken: await mintSession(a.http, b.key, bSpecId, 'u1'),
    };
  }

  it('answers a preflight only for an origin some tenant allows', async () => {
    const { http } = await twoShops();
    const ok = await request(http)
      .options('/approvals')
      .set('origin', SHOP_A)
      .set('access-control-request-method', 'GET')
      .set('access-control-request-headers', 'authorization')
      .expect(204);
    expect(ok.headers['access-control-allow-origin']).toBe(SHOP_A);
    expect(ok.headers['access-control-allow-headers']).toContain('authorization');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    expect(ok.headers.vary).toBe('Origin');

    const evil = await request(http)
      .options('/approvals')
      .set('origin', 'https://evil.example')
      .set('access-control-request-method', 'GET')
      .expect(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("accepts a session only from its own tenant's origins", async () => {
    const { http, aToken, bToken } = await twoShops();
    const ok = await request(http)
      .get('/approvals')
      .set('origin', SHOP_A)
      .set('authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe(SHOP_A);
    expect(ok.headers.vary).toContain('Origin');

    await request(http)
      .get('/approvals')
      .set('origin', 'https://evil.example')
      .set('authorization', `Bearer ${aToken}`)
      .expect(403);
    // Tenant B's token from tenant A's shop: the origin is known, but not B's.
    const cross = await request(http)
      .get('/approvals')
      .set('origin', SHOP_A)
      .set('authorization', `Bearer ${bToken}`)
      .expect(403);
    expect(cross.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a tenant API key from a browser, and accepts it from a server', async () => {
    const { http, aKey } = await twoShops();
    await request(http)
      .get('/specs')
      .set('origin', SHOP_A)
      .set('authorization', `Bearer ${aKey}`)
      .expect(403);
    await request(http).get('/specs').set('authorization', `Bearer ${aKey}`).expect(200);
  });

  it('puts the CORS header on the event stream too', async () => {
    const { http, aToken } = await twoShops();
    const started = await request(http)
      .post('/runs')
      .set('origin', SHOP_A)
      .set('authorization', `Bearer ${aToken}`)
      .send({ message: 'hello' })
      .expect(202);
    const runId = body<{ runId: string }>(started).runId;
    // Over real HTTP: read the stream's headers, then disconnect (no worker runs this run).
    const app = h?.app;
    if (!app) throw new Error('no harness');
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${String(port)}/runs/${runId}/events`, {
      headers: { origin: SHOP_A, authorization: `Bearer ${aToken}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP_A);
    controller.abort();
  });

  it('accepts only bare http(s) origins', async () => {
    const { http, aKey } = await twoShops();
    for (const bad of [
      'https://shop.example/app',
      'https://shop.example/',
      '*',
      'ftp://x.example',
    ]) {
      await request(http)
        .put('/tenant/origins')
        .set('authorization', `Bearer ${aKey}`)
        .send({ origins: [bad] })
        .expect(400);
    }
    const ok = await request(http)
      .put('/tenant/origins')
      .set('authorization', `Bearer ${aKey}`)
      .send({ origins: ['https://Shop.Example', 'http://localhost:5173'] })
      .expect(200);
    expect(body<{ allowedOrigins: string[] }>(ok).allowedOrigins).toEqual([
      'https://shop.example',
      'http://localhost:5173',
    ]);
  });
});
