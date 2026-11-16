import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Order } from '../src/domain/order.schema.js';
import { body, startHarness, type Harness } from './harness.js';

interface RefundBody {
  _id: string;
  status: string;
  amountCents: number;
  requestedBy: string | null;
  processedBy: string | null;
  decisionNote: string | null;
}

describe('refunds (e2e)', () => {
  let h: Harness;
  /** Delivered orders with nothing refunded yet; each test takes its own so tests stay independent. */
  let freshOrders: Order[];

  const as = (role: 'owner' | 'support' | 'warehouse') => ({
    post: (path: string, payload: object = {}) =>
      request(h.http).post(path).auth(h.tokens[role], { type: 'bearer' }).send(payload),
    get: (path: string) => request(h.http).get(path).auth(h.tokens[role], { type: 'bearer' }),
  });
  const committed = async (orderId: string) =>
    body<Order>(await as('support').get(`/orders/${orderId}`).expect(200)).refundCommittedCents;
  const takeOrder = () => {
    const order = freshOrders.shift();
    if (!order) throw new Error('ran out of fresh delivered orders');
    return { id: order._id.toHexString(), total: order.totalCents };
  };
  const staffId = async (role: 'owner' | 'support') =>
    body<{ _id: string }>(await as(role).get('/auth/me').expect(200))._id;

  beforeAll(async () => {
    h = await startHarness();
    freshOrders = h.data.orders.filter(
      (o) => o.status === 'delivered' && o.refundCommittedCents === 0 && o.totalCents > 1000,
    );
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('support requests, owner approves; the order counts the amount at request time', async () => {
    const order = takeOrder();
    const requested = body<RefundBody>(
      await as('support')
        .post('/refunds', { orderId: order.id, amountCents: order.total - 100, reason: 'damaged' })
        .expect(201),
    );
    expect(requested).toMatchObject({ status: 'pending', requestedBy: await staffId('support') });
    expect(await committed(order.id)).toBe(order.total - 100);

    // Asking for more than the 100 cents left is refused.
    const over = await as('support')
      .post('/refunds', { orderId: order.id, amountCents: 101, reason: 'other' })
      .expect(409);
    expect(body<{ message: string }>(over).message).toContain('100 cents left');

    // Only the owner can approve, and only once.
    await as('support').post(`/refunds/${requested._id}/approve`).expect(403);
    const approved = body<RefundBody>(
      await as('owner')
        .post(`/refunds/${requested._id}/approve`, { note: 'Photo received.' })
        .expect(200),
    );
    expect(approved).toMatchObject({
      status: 'completed',
      processedBy: await staffId('owner'),
      decisionNote: 'Photo received.',
    });
    await as('owner').post(`/refunds/${requested._id}/approve`).expect(409);
  });

  it('rejecting a refund releases its amount back to the order', async () => {
    const order = takeOrder();
    const requested = body<RefundBody>(
      await as('support')
        .post('/refunds', { orderId: order.id, amountCents: order.total, reason: 'changed_mind' })
        .expect(201),
    );
    expect(await committed(order.id)).toBe(order.total);

    await as('owner').post(`/refunds/${requested._id}/reject`).expect(400); // a note is required
    await as('owner')
      .post(`/refunds/${requested._id}/reject`, { note: 'Outside the return window.' })
      .expect(200);
    expect(await committed(order.id)).toBe(0);

    // The released amount can be requested again.
    await as('support')
      .post('/refunds', { orderId: order.id, amountCents: order.total, reason: 'damaged' })
      .expect(201);
  });

  it('two simultaneous requests for the full amount: exactly one succeeds', async () => {
    const order = takeOrder();
    const send = () =>
      as('support').post('/refunds', {
        orderId: order.id,
        amountCents: order.total,
        reason: 'damaged',
      });

    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(await committed(order.id)).toBe(order.total);
    const list = body<{ total: number }>(
      await as('support').get(`/refunds?orderId=${order.id}`).expect(200),
    );
    expect(list.total).toBe(1);
  });

  it('refuses refunds for orders that have not shipped', async () => {
    const pending = h.data.orders.find((o) => o.status === 'pending');
    if (!pending) throw new Error('seed has no pending order');
    await as('support')
      .post('/refunds', { orderId: pending._id.toHexString(), amountCents: 100, reason: 'other' })
      .expect(409);
  });

  it('does not let warehouse staff request refunds', async () => {
    const order = takeOrder();
    await as('warehouse')
      .post('/refunds', { orderId: order.id, amountCents: 100, reason: 'other' })
      .expect(403);
    expect(await committed(order.id)).toBe(0);
  });
});
