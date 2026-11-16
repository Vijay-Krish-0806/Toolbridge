import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { body, signJwt, startHarness, type Harness } from './harness.js';

interface Me {
  _id: string;
  email: string;
  role: string;
}

describe('auth (e2e)', () => {
  let h: Harness;
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('logs in with the right password and returns a bearer token', async () => {
    const response = await request(h.http)
      .post('/auth/login')
      .send({ email: 'support@store.example', password: h.config.SEED_STAFF_PASSWORD })
      .expect(200);
    expect(body(response)).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, role: 'support' });
  });

  it('gives the same 401 for a wrong password and an unknown email (no account probing)', async () => {
    const wrongPassword = await request(h.http)
      .post('/auth/login')
      .send({ email: 'support@store.example', password: 'wrong-password' })
      .expect(401);
    const unknownEmail = await request(h.http)
      .post('/auth/login')
      .send({ email: 'nobody@store.example', password: 'wrong-password' })
      .expect(401);
    expect(body(wrongPassword)).toEqual(body(unknownEmail));
  });

  it('rejects unknown fields in the login body', async () => {
    await request(h.http)
      .post('/auth/login')
      .send({ email: 'owner@store.example', password: 'x', role: 'owner' })
      .expect(400);
  });

  it('returns 401 without a token, and lets public routes through', async () => {
    await request(h.http).get('/orders').expect(401);
    await request(h.http).get('/health').expect(200);
  });

  it('returns 401 for a token whose role was edited (signature no longer matches)', async () => {
    const [header, payload, signature] = h.tokens.support.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, role: 'owner' })).toString(
      'base64url',
    );
    const forged = `${header ?? ''}.${forgedPayload}.${signature ?? ''}`;

    await request(h.http)
      .get('/reports/sales-summary')
      .auth(forged, { type: 'bearer' })
      .expect(401);
  });

  it('returns 401 for an expired token, even with a valid signature', async () => {
    const me = body<Me>(
      await request(h.http).get('/auth/me').auth(h.tokens.owner, { type: 'bearer' }).expect(200),
    );
    const claims = { sub: me._id, email: me.email, role: me.role };
    const valid = signJwt(
      { ...claims, iat: nowSeconds(), exp: nowSeconds() + 60 },
      h.config.JWT_SECRET,
    );
    const expired = signJwt(
      { ...claims, iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 },
      h.config.JWT_SECRET,
    );

    // Control: the hand-signed token is accepted while fresh, so the 401 below is about expiry.
    await request(h.http).get('/auth/me').auth(valid, { type: 'bearer' }).expect(200);
    await request(h.http).get('/auth/me').auth(expired, { type: 'bearer' }).expect(401);
  });

  it('returns 403 when the role is not allowed, and 200 when it is', async () => {
    await request(h.http)
      .get('/customers')
      .auth(h.tokens.warehouse, { type: 'bearer' })
      .expect(403);
    await request(h.http).get('/customers').auth(h.tokens.support, { type: 'bearer' }).expect(200);
    await request(h.http)
      .get('/reports/sales-summary')
      .auth(h.tokens.support, { type: 'bearer' })
      .expect(403);
    await request(h.http)
      .get('/reports/sales-summary')
      .auth(h.tokens.owner, { type: 'bearer' })
      .expect(200);
  });
});
