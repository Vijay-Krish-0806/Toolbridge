/**
 * Step 4.4b session (a) acceptance: session tokens and identity.
 * REQUIRED (BUILD_PLAN section 4 and the 4.4b done-check):
 * - forged, tampered, expired, wrong-audience, wrong-algorithm (`alg: none`, HS512) and replayed
 *   (after revocation, or with an unknown id) tokens are rejected;
 * - a browser cannot choose its own role: only roles of the spec's policy can be minted, by the
 *   host's backend; run and approval routes take user and role only from the token;
 * - the host user's own token is never in the session token or in clear in the database;
 * - tenant isolation and per-user isolation: another user's run is a 404; a session for one spec
 *   cannot see or decide cards of another spec.
 * Tokens are crafted with jose and the test signing key to try each attack.
 */
import { randomUUID } from 'node:crypto';

import {
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import { decodeJwt, SignJWT } from 'jose';
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
  mintSession,
  SESSION_KEY,
  startHarness,
} from './harness.js';

/** Asks for one high-risk refund, then answers: enough to make an approval card. */
class RefundOnce implements LLMProvider {
  generate(req: GenerateRequest): Promise<GenerateResult> {
    const told = req.messages.at(-1)?.role === 'tool';
    return Promise.resolve(
      told
        ? { message: { role: 'assistant', content: 'ok', toolCalls: [] }, finishReason: 'stop' }
        : {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'c1',
                  name: 'refunds_request',
                  arguments: '{"orderId":"ORD-7","amountCents":32893,"reason":"damaged"}',
                },
              ],
            },
            finishReason: 'tool_calls',
          },
    );
  }
  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(req)]).stream(req);
  }
}

let h: Harness;
const key = new Uint8Array(Buffer.from(SESSION_KEY, 'base64'));

const as = (token: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${token}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${token}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${token}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${token}`),
  del: (path: string) => request(h.http).delete(path).set('authorization', `Bearer ${token}`),
});

/** Registers the host spec with a connection, refunds enabled and the host policy. */
async function spec(apiKey: string, name: string): Promise<string> {
  const response = await as(apiKey)
    .post('/specs')
    .send({ name, document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(response).spec.id;
  await as(apiKey)
    .put(`/specs/${specId}/connection`)
    .send({ baseUrl: 'http://localhost:9', authKind: 'static', secrets: { bearer: 'x' } })
    .expect(200);
  await as(apiKey)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .send({ enabled: true })
    .expect(200);
  await as(apiKey).put(`/specs/${specId}/policy`).send({ policy: hostPolicy() }).expect(200);
  return specId;
}

/** A token with the right shape, signed by `signWith`; `change` alters claims or header. */
async function craft(
  base: Record<string, unknown>,
  options: { exp?: number; aud?: string; alg?: string; signWith?: Uint8Array } = {},
): Promise<string> {
  return new SignJWT(base)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .setIssuer('toolbridge')
    .setAudience(options.aud ?? 'toolbridge-run-api')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(options.signWith ?? key);
}

let tenant: { id: string; key: string };
let specA: string;
let specB: string;
let u1: string;

beforeAll(async () => {
  h = await startHarness({}, { llm: new RefundOnce() });
  tenant = await createTenant(h.http, 'Acme');
  specA = await spec(tenant.key, 'store');
  specB = await spec(tenant.key, 'store-two');
  u1 = await mintSession(h.http, tenant.key, specA, 'u1');
});

afterAll(async () => {
  await h.stop();
});

describe('minting sessions (token exchange)', () => {
  it('mints a short-lived token that carries tenant, spec, user and role', async () => {
    const response = await as(tenant.key)
      .post('/sessions')
      .send({ specId: specA, userId: 'u9', role: 'warehouse', ttlSeconds: 120 })
      .expect(201);
    const { token, expiresAt } = body<{ token: string; expiresAt: string }>(response);
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: 'toolbridge',
      aud: 'toolbridge-run-api',
      sub: 'u9',
      ten: tenant.id,
      spec: specA,
      role: 'warehouse',
    });
    expect(typeof claims.jti).toBe('string');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(120);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('only mints roles of the spec policy, never longer than an hour, only for own specs', async () => {
    await as(tenant.key)
      .post('/sessions')
      .send({ specId: specA, userId: 'u1', role: 'admin' })
      .expect(422);
    await as(tenant.key)
      .post('/sessions')
      .send({ specId: specA, userId: 'u1', role: 'support', ttlSeconds: 7200 })
      .expect(400);
    const other = await createTenant(h.http, 'Other');
    await as(other.key)
      .post('/sessions')
      .send({ specId: specA, userId: 'u1', role: 'owner' })
      .expect(404);
    // A session token cannot mint more sessions: only the host's backend (API key) can.
    await as(u1).post('/sessions').send({ specId: specA, userId: 'u1', role: 'owner' }).expect(401);
  });

  it('keeps the host user token server-side: not in the JWT, the response or the database', async () => {
    const hostToken = `host-user-token-${randomUUID()}`;
    const response = await as(tenant.key)
      .post('/sessions')
      .send({ specId: specA, userId: 'u7', role: 'support', userToken: hostToken })
      .expect(201);
    expect(JSON.stringify(response.body)).not.toContain(hostToken);
    const { token } = body<{ token: string }>(response);
    expect(JSON.stringify(decodeJwt(token))).not.toContain(hostToken);

    const connection = await mongoose
      .createConnection(h.config.MONGO_URI, { dbName: h.config.PLATFORM_MONGO_DB })
      .asPromise();
    try {
      const raw = await connection.collection('sessions').findOne({ userId: 'u7' });
      expect(JSON.stringify(raw)).not.toContain(hostToken);
      expect(raw?.userToken).toMatchObject({ algorithm: 'AES-256-GCM' });
    } finally {
      await connection.close();
    }
  });
});

describe('rejected tokens (all 401, same message)', () => {
  /** The claims of a real, live session, to build attacks from. */
  function realClaims(): Record<string, unknown> {
    const { ten, spec: s, role, sub, jti } = decodeJwt(u1);
    return { ten, spec: s, role, sub, jti };
  }
  const denied = async (token: string) => {
    const response = await as(token).get('/approvals').expect(401);
    expect(body<{ message: string }>(response).message).toBe(
      'Missing, invalid, expired or revoked credentials.',
    );
  };

  it('accepts the real token', async () => {
    await as(u1).get('/approvals').expect(200);
  });

  it('rejects a token signed with another key (forged)', async () => {
    await denied(await craft(realClaims(), { signWith: new Uint8Array(32).fill(9) }));
  });

  it('rejects a token whose payload was changed (role raised to owner)', async () => {
    const [header, payload, signature] = u1.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const raised = Buffer.from(JSON.stringify({ ...claims, role: 'owner' })).toString('base64url');
    await denied(`${header ?? ''}.${raised}.${signature ?? ''}`);
  });

  it('rejects an expired token', async () => {
    await denied(await craft(realClaims(), { exp: Math.floor(Date.now() / 1000) - 10 }));
  });

  it('rejects a token for another audience', async () => {
    await denied(await craft(realClaims(), { aud: 'some-other-service' }));
  });

  it('rejects alg "none" and any algorithm but HS256', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = u1.split('.')[1] ?? '';
    await denied(`${header}.${payload}.`);
    await denied(await craft(realClaims(), { alg: 'HS512' }));
  });

  it('rejects a well-signed token whose session does not exist (unknown jti)', async () => {
    await denied(await craft({ ...realClaims(), jti: randomUUID() }));
  });

  it('rejects a token replayed after it was revoked (logout)', async () => {
    const token = await mintSession(h.http, tenant.key, specA, 'u5');
    await as(token).get('/approvals').expect(200);
    await as(token).del('/sessions/current').expect(200);
    await denied(token);
  });
});

describe('identity comes only from the token', () => {
  it('refuses a role, user or spec in the body, and the API key on run routes', async () => {
    await as(u1)
      .post('/runs')
      .send({ message: 'hi', principal: { userId: 'u1', role: 'owner' } })
      .expect(400);
    await as(u1).post('/runs').send({ message: 'hi', specId: specB }).expect(400);
    await as(tenant.key).post('/runs').send({ message: 'hi' }).expect(401);
    await as(tenant.key).get('/approvals').expect(401);
  });

  it('shows a run only to its own user', async () => {
    const started = await as(u1).post('/runs').send({ message: 'hello' }).expect(202);
    const runId = body<{ runId: string }>(started).runId;
    const run = body<{ principal: unknown }>(await as(u1).get(`/runs/${runId}`).expect(200));
    expect(run.principal).toEqual({ userId: 'u1', role: 'support' }); // from the token
    const colleague = await mintSession(h.http, tenant.key, specA, 'u2');
    await as(colleague).get(`/runs/${runId}`).expect(404);
    await as(colleague).post(`/runs/${runId}/cancel`).expect(404);
  });

  it('a session for one spec cannot see or decide the cards of another spec', async () => {
    const started = await as(u1).post('/runs').send({ message: 'refund please' }).expect(202);
    const runId = body<{ runId: string }>(started).runId;
    let approvalId: string | null = null;
    for (let i = 0; i < 100 && !approvalId; i++) {
      approvalId = body<{ approvalId: string | null }>(
        await as(u1).get(`/runs/${runId}`),
      ).approvalId;
      if (!approvalId) await new Promise((r) => setTimeout(r, 50));
    }
    if (!approvalId) throw new Error('the run never paused');

    const onSpecB = await mintSession(h.http, tenant.key, specB, 'u2');
    const listed = body<{ id: string }[]>(await as(onSpecB).get('/approvals').expect(200));
    expect(listed.map((c) => c.id)).not.toContain(approvalId);
    await as(onSpecB).post(`/approvals/${approvalId}/approve`).send({}).expect(404);

    // The requester cannot approve their own high-risk card; a colleague on the same spec can.
    await as(u1).post(`/approvals/${approvalId}/approve`).send({}).expect(403);
    const colleague = await mintSession(h.http, tenant.key, specA, 'u2');
    const decided = await as(colleague)
      .post(`/approvals/${approvalId}/approve`)
      .send({})
      .expect(202);
    expect(body<{ approval: { approverId: string } }>(decided).approval.approverId).toBe('u2');
  });
});
