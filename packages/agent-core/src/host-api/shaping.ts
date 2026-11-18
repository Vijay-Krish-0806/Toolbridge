/**
 * Result shaping: turn a raw API page into a compact summary for the model.
 * The context window is a budget. A raw page of 20 orders is about 11,000 characters because
 * each order carries line items, ids and notes. A list view only needs a few fields; the model can
 * call get_order for full detail. Leaving out free-text notes also shrinks the room for prompt
 * injection hidden in data.
 */
import { z } from 'zod';
import { ToolExecutionError } from '../tools/errors.js';

const pageFields = { page: z.number(), limit: z.number(), total: z.number() };

const orderPageSchema = z.object({
  ...pageFields,
  items: z.array(
    z.object({
      number: z.string(),
      status: z.string(),
      customerId: z.string(),
      totalCents: z.number(),
      placedAt: z.string(),
      items: z.array(z.unknown()),
    }),
  ),
});

const productPageSchema = z.object({
  ...pageFields,
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      category: z.string(),
      priceCents: z.number(),
      active: z.boolean(),
    }),
  ),
});

/** Where this page sits in the full result, so the model knows whether to ask for more. */
interface PageInfo {
  page: number;
  total: number;
  hasMore: boolean;
  nextPage: number | null;
}

/**
 * Works out the pagination hint from the API's page fields:
 *   { page: 1, limit: 20, total: 50 }  ->  { page: 1, total: 50, hasMore: true, nextPage: 2 }
 */
function pageInfo({
  page,
  limit,
  total,
}: {
  page: number;
  limit: number;
  total: number;
}): PageInfo {
  const hasMore = page * limit < total;
  return { page, total, hasMore, nextPage: hasMore ? page + 1 : null };
}

/**
 * Validates `raw` against `schema`. A mismatch means the API changed shape, so it fails loudly
 * as an internal error instead of sending the model half-understood data.
 */
function parsePage<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolExecutionError(
      'internal',
      `Unexpected ${label} response shape from the host API`,
    );
  }
  return parsed.data;
}

/**
 * Shrinks a raw order page to one line of key facts per order, plus the pagination hint:
 *   { items: [{ _id, number, items: [...4 line items], notes, ... }], page, limit, total }
 *   ->  { orders: [{ number, status, customerId, totalCents, placedAt, itemCount }], page, total, hasMore, nextPage }
 */
export function shapeOrderPage(raw: unknown) {
  const data = parsePage(orderPageSchema, raw, 'order list');
  return {
    orders: data.items.map((order) => ({
      number: order.number,
      status: order.status,
      customerId: order.customerId,
      totalCents: order.totalCents,
      placedAt: order.placedAt,
      itemCount: order.items.length,
    })),
    ...pageInfo(data),
  };
}

/**
 * Shrinks a raw product page to the fields a catalog question needs, plus the pagination hint.
 * Drops the internal id, long description and timestamps.
 */
export function shapeProductPage(raw: unknown) {
  const data = parsePage(productPageSchema, raw, 'product list');
  return {
    products: data.items.map(({ sku, name, category, priceCents, active }) => ({
      sku,
      name,
      category,
      priceCents,
      active,
    })),
    ...pageInfo(data),
  };
}
