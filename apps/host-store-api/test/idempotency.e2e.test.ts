/**
 * REQUIRED (BUILD_PLAN section 4, idempotency: no double refund), Step 4.5: write routes honour
 * an `Idempotency-Key`. A repeat gets the stored answer and does not refund again; ten requests at
 * once with one key make one refund; a key reused for another request is refused; keys are per
 * user; a refused request is replayed as the same refusal.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Order } from '../src/domain/order.schema.js';
import { body, startHarness, type Harness } from './harness.js';

interface RefundBody {
  _id: string;
  amountCents: number;
}

describe('idempotency keys (e2e)', () => {
  let h: Harness;
  let freshOrders: Order[];

  const refund = (
    role: 'owner' | 'support',
    key: string | undefined,
    payload: { orderId: string; amountCents: number; reason: string },
  ) => {
    const req = request(h.http).post('/refunds').auth(h.tokens[role], { type: 'bearer' });
    return (key ? req.set('idempotency-key', key) : req).send(payload);
  };
  /** How many refunds the order has (straight from the API). */
  const refundsOf = async (orderId: string): Promise<number> => {
    const response = await request(h.http)
      .get(`/refunds?orderId=${orderId}&limit=100`)
      .auth(h.tokens.owner, { type: 'bearer' })
      .expect(200);
    return body<{ items: unknown[] }>(response).items.length;
  };
  const takeOrder = () => {
    const order = freshOrders.shift();
    if (!order) throw new Error('ran out of fresh delivered orders');
    return order._id.toHexString();
  };

  beforeAll(async () => {
    h = await startHarness();
    freshOrders = h.data.orders.filter(
      (o) => o.status === 'delivered' && o.refundCommittedCents === 0 && o.totalCents > 1000,
    );
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('a repeat with the same key gets the same answer and refunds only once', async () => {
    const orderId = takeOrder();
    const payload = { orderId, amountCents: 500, reason: 'damaged' };
    const first = await refund('support', 'run-1:call-1', payload).expect(201);
    const again = await refund('support', 'run-1:call-1', payload).expect(201);
    expect(body<RefundBody>(again)._id).toBe(body<RefundBody>(first)._id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await refundsOf(orderId)).toBe(1);
  });

  it('ten requests at once with one key make exactly one refund', async () => {
    const orderId = takeOrder();
    const payload = { orderId, amountCents: 300, reason: 'damaged' };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => refund('support', 'parallel-key', payload)),
    );
    const statuses = responses.map((r) => r.status);
    // Each one either did it, replayed it, or was told it is still in progress: never a second refund.
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses).toContain(201);
    expect(await refundsOf(orderId)).toBe(1);
  });

  it('refuses a key reused for a different request (422)', async () => {
    const orderId = takeOrder();
    await refund('support', 'reused', { orderId, amountCents: 200, reason: 'damaged' }).expect(201);
    await refund('support', 'reused', { orderId, amountCents: 999, reason: 'damaged' }).expect(422);
    expect(await refundsOf(orderId)).toBe(1);
  });

  it('scopes keys to the user: the same key from another user is a separate request', async () => {
    const orderId = takeOrder();
    const payload = { orderId, amountCents: 100, reason: 'damaged' };
    await refund('support', 'shared-key', payload).expect(201);
    const owner = await refund('owner', 'shared-key', payload).expect(201);
    expect(owner.headers['idempotent-replayed']).toBeUndefined();
    expect(await refundsOf(orderId)).toBe(2);
  });

  it('replays a refusal as the same refusal, and works as before without a key', async () => {
    const orderId = takeOrder();
    const tooMuch = { orderId, amountCents: 99_999_999, reason: 'damaged' };
    const first = await refund('support', 'too-much', tooMuch).expect(409);
    const again = await refund('support', 'too-much', tooMuch).expect(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(body<{ message: string }>(again).message).toBe(body<{ message: string }>(first).message);

    const payload = { orderId, amountCents: 100, reason: 'damaged' };
    await refund('support', undefined, payload).expect(201);
    await refund('support', undefined, payload).expect(201);
    expect(await refundsOf(orderId)).toBe(2); // no key: no deduplication, as before
  });
});
