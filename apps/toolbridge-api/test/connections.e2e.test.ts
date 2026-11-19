/**
 * Step 2.6b acceptance: tenant credentials are stored with envelope encryption, never returned,
 * bound to their tenant, used only for enabled tools, and survive a master-key rotation.
 * A local fake API stands in for a tenant's backend and records the Authorization headers it gets.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN_KEY,
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostSpec,
  MASTER_KEY_V1,
  MASTER_KEY_V2,
  startHarness,
} from './harness.js';

const TOKEN = 'secret-token-123';
const LOGIN_TOKEN = 'login-token-456';
const PASSWORD = 'pw-never-shown';

let h: Harness;
let upstream: Server;
let baseUrl: string;
const seenAuth: string[] = [];

/** The fake tenant API: a login route and two order routes that require a valid bearer token. */
function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/auth/login') {
        const { email, password } = JSON.parse(raw || '{}') as Record<string, string>;
        const ok = email === 'svc@shop.example' && password === PASSWORD;
        res
          .writeHead(ok ? 200 : 401)
          .end(JSON.stringify(ok ? { accessToken: LOGIN_TOKEN } : { message: 'bad login' }));
        return;
      }
      const auth = req.headers.authorization ?? '';
      seenAuth.push(auth);
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${LOGIN_TOKEN}`) {
        res.writeHead(401).end(JSON.stringify({ message: 'Invalid or expired access token.' }));
      } else if (req.url?.startsWith('/orders/by-number/')) {
        res.end(JSON.stringify({ number: req.url.split('/').pop(), status: 'paid' }));
      } else if (req.url?.endsWith('/cancel')) {
        res.end(JSON.stringify({ cancelled: true }));
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

/** Registers the host spec (with overrides) for a tenant; returns the spec id. */
async function registerSpec(key: string): Promise<string> {
  const response = await as(key)
    .post('/specs')
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  return body<{ spec: { id: string } }>(response).spec.id;
}

/** The raw connection documents, read straight from MongoDB (what a database thief would see). */
async function rawConnections(): Promise<Record<string, unknown>[]> {
  const connection = await mongoose
    .createConnection(h.config.MONGO_URI, { dbName: h.config.PLATFORM_MONGO_DB })
    .asPromise();
  try {
    return await connection.collection('apiconnections').find({}).toArray();
  } finally {
    await connection.close();
  }
}

beforeAll(async () => {
  upstream = await startUpstream();
  baseUrl = `http://localhost:${String((upstream.address() as AddressInfo).port)}`;
  h = await startHarness();
});

afterAll(async () => {
  upstream.closeAllConnections();
  upstream.close();
  await h.app.close();
});

describe('connections and tool calls', () => {
  let alice: { id: string; key: string };
  let bob: { id: string; key: string };
  let aliceSpec: string;
  let bobSpec: string;

  beforeAll(async () => {
    alice = await createTenant(h.http, 'Alice');
    bob = await createTenant(h.http, 'Bob');
    aliceSpec = await registerSpec(alice.key);
    bobSpec = await registerSpec(bob.key);
  });

  it('stores a static secret write-only: never in a response, never in clear in the database', async () => {
    const set = await as(alice.key)
      .put(`/specs/${aliceSpec}/connection`)
      .send({ baseUrl, authKind: 'static', secrets: { bearer: TOKEN } })
      .expect(200);
    const read = await as(alice.key).get(`/specs/${aliceSpec}/connection`).expect(200);
    for (const response of [set, read]) expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect(body<Record<string, unknown>>(read)).toMatchObject({
      authKind: 'static',
      schemes: ['bearer'],
      hasSecret: true,
      keyVersion: 'v1',
    });

    const raw = await rawConnections();
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect(raw[0]?.secret).toMatchObject({
      algorithm: 'AES-256-GCM',
      dataKey: { keyVersion: 'v1' },
    });
  });

  it('refuses a secret for a security scheme the spec does not declare', async () => {
    await as(alice.key)
      .put(`/specs/${aliceSpec}/connection`)
      .send({ baseUrl, authKind: 'static', secrets: { madeUp: 'x' } })
      .expect(422);
  });

  it('calls an enabled tool with the decrypted secret', async () => {
    const response = await as(alice.key)
      .post(`/specs/${aliceSpec}/tools/orders_get/call`)
      .send({ arguments: { number: 'ORD-10001' } })
      .expect(200);
    expect(body<{ ok: boolean; content: string }>(response)).toMatchObject({ ok: true });
    expect(body<{ content: string }>(response).content).toContain('ORD-10001');
    expect(seenAuth.at(-1)).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a disabled tool at call time (defense in depth), and allows it once enabled', async () => {
    const args = { arguments: { id: 'a'.repeat(24), reason: 'test' } };
    await as(alice.key).post(`/specs/${aliceSpec}/tools/orders_cancel/call`).send(args).expect(403);
    await as(alice.key)
      .patch(`/specs/${aliceSpec}/tools/orders_cancel`)
      .send({ enabled: true })
      .expect(200);
    const response = await as(alice.key)
      .post(`/specs/${aliceSpec}/tools/orders_cancel/call`)
      .send(args)
      .expect(200);
    expect(body<{ ok: boolean }>(response).ok).toBe(true);
  });

  it("cannot read, replace or use another tenant's connection", async () => {
    await as(bob.key).get(`/specs/${aliceSpec}/connection`).expect(404);
    await as(bob.key)
      .put(`/specs/${aliceSpec}/connection`)
      .send({ baseUrl, authKind: 'none' })
      .expect(404);
    await as(bob.key)
      .post(`/specs/${aliceSpec}/tools/orders_get/call`)
      .send({ arguments: { number: 'ORD-1' } })
      .expect(404);
  });

  it("a ciphertext copied into another tenant's record does not decrypt (AAD binding)", async () => {
    await as(bob.key)
      .put(`/specs/${bobSpec}/connection`)
      .send({ baseUrl, authKind: 'static', secrets: { bearer: 'bobs-own-token' } })
      .expect(200);
    const connection = await mongoose
      .createConnection(h.config.MONGO_URI, { dbName: h.config.PLATFORM_MONGO_DB })
      .asPromise();
    try {
      const raw = connection.collection('apiconnections');
      const aliceDoc = await raw.findOne({ tenantId: new mongoose.Types.ObjectId(alice.id) });
      await raw.updateOne(
        { tenantId: new mongoose.Types.ObjectId(bob.id) },
        { $set: { secret: aliceDoc?.secret } },
      );
    } finally {
      await connection.close();
    }
    const response = await as(bob.key)
      .post(`/specs/${bobSpec}/tools/orders_get/call`)
      .send({ arguments: { number: 'ORD-1' } })
      .expect(500);
    expect(body<{ message: string }>(response).message).toBe(
      'The stored credential could not be decrypted; set the connection again.',
    );
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('logs in with stored credentials (login auth) and uses the returned token', async () => {
    await as(bob.key)
      .put(`/specs/${bobSpec}/connection`)
      .send({
        baseUrl,
        authKind: 'login',
        loginPath: '/auth/login',
        tokenField: 'accessToken',
        loginFields: { email: 'svc@shop.example', password: PASSWORD },
      })
      .expect(200);
    const read = await as(bob.key).get(`/specs/${bobSpec}/connection`).expect(200);
    expect(JSON.stringify(read.body)).not.toContain(PASSWORD);
    const response = await as(bob.key)
      .post(`/specs/${bobSpec}/tools/orders_get/call`)
      .send({ arguments: { number: 'ORD-2' } })
      .expect(200);
    expect(body<{ ok: boolean }>(response).ok).toBe(true);
    expect(seenAuth.at(-1)).toBe(`Bearer ${LOGIN_TOKEN}`);
  });

  it('says clearly when a spec has no connection yet', async () => {
    const carol = await createTenant(h.http, 'Carol');
    const spec = await registerSpec(carol.key);
    await as(carol.key)
      .post(`/specs/${spec}/tools/orders_get/call`)
      .send({ arguments: { number: 'ORD-1' } })
      .expect(409);
  });
});

describe('master-key rotation', () => {
  it('re-wraps data keys under a new master key, then works with the old key retired', async () => {
    await h.app.close();
    h = await startHarness(); // fresh database, master key v1
    const dave = await createTenant(h.http, 'Dave');
    const spec = await registerSpec(dave.key);
    await as(dave.key)
      .put(`/specs/${spec}/connection`)
      .send({ baseUrl, authKind: 'static', secrets: { bearer: TOKEN } })
      .expect(200);
    const before = JSON.stringify(await rawConnections());
    const call = () =>
      as(dave.key)
        .post(`/specs/${spec}/tools/orders_get/call`)
        .send({ arguments: { number: 'ORD-9' } });

    // 1. Rotate: new current key v2, old v1 kept as "previous". Old data still decrypts.
    await h.app.close();
    h = await startHarness(
      {
        PLATFORM_MASTER_KEY: MASTER_KEY_V2,
        PLATFORM_MASTER_KEY_VERSION: 'v2',
        PLATFORM_PREVIOUS_MASTER_KEYS: `v1=${MASTER_KEY_V1}`,
      },
      { keepDatabase: true },
    );
    expect(body<{ ok: boolean }>(await call().expect(200)).ok).toBe(true);

    // 2. Re-wrap every data key under v2 (admin). Only the wrapped data key changes.
    const rewrap = await request(h.http)
      .post('/admin/connections/rewrap')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .expect(200);
    expect(body<{ rewrapped: number; currentVersion: string }>(rewrap)).toMatchObject({
      rewrapped: 1,
      currentVersion: 'v2',
    });
    const after = (await rawConnections())[0] as {
      secret: { ciphertext: string; dataKey: { keyVersion: string } };
    };
    const beforeDoc = (JSON.parse(before) as (typeof after)[])[0];
    expect(after.secret.dataKey.keyVersion).toBe('v2');
    expect(after.secret.ciphertext).toBe(beforeDoc?.secret.ciphertext);

    // 3. Retire v1 completely: everything still works on v2 alone.
    await h.app.close();
    h = await startHarness(
      { PLATFORM_MASTER_KEY: MASTER_KEY_V2, PLATFORM_MASTER_KEY_VERSION: 'v2' },
      { keepDatabase: true },
    );
    expect(body<{ ok: boolean }>(await call().expect(200)).ok).toBe(true);
  });

  it('refuses to start with a master key that is not 32 bytes', async () => {
    await expect(
      startHarness(
        { PLATFORM_MASTER_KEY: Buffer.alloc(16).toString('base64') },
        { keepDatabase: true },
      ),
    ).rejects.toThrow('must be base64 of exactly 32 bytes');
  });
});
