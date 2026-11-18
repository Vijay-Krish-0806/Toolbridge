/**
 * Five hand-written tools for the host store API, written from its OpenAPI spec only (never from
 * host-app code). Phase 2 generates tools like these automatically; writing a few by hand first
 * shows what a good tool looks like.
 */
import { z } from 'zod';
import { defineTool, type Tool } from '../tools/tool.js';
import { ToolExecutionError } from '../tools/errors.js';
import type { HostApiClient } from './client.js';
import { shapeOrderPage, shapeProductPage } from './shaping.js';

const orderNumber = z
  .string()
  .regex(/^ORD-\d+$/i, 'must look like ORD-10042')
  .describe('Order number, for example ORD-10042.');

/** Capped at 20 (the API allows 100) so one result cannot flood a small model's context. */
const limit = z.number().int().min(1).max(20).default(10).describe('Items per page, at most 20.');
const page = z.number().int().min(1).default(1).describe('Page number, starting at 1.');

/** Builds the five host-store tools, all sharing one authenticated API client. */
export function createHostStoreTools(api: HostApiClient): Tool[] {
  const listOrders = defineTool({
    name: 'list_orders',
    description:
      'List orders, newest first, with optional filters. Returns a short summary per order ' +
      '(number, status, customerId, totalCents, placedAt, itemCount) plus total, hasMore and nextPage. ' +
      'If hasMore is true, call again with page = nextPage to get the rest. Amounts are in cents. ' +
      'For line items or notes of one order, use get_order.',
    safety: 'read',
    input: z.object({
      status: z
        .enum(['pending', 'paid', 'shipped', 'delivered', 'cancelled'])
        .optional()
        .describe('Only orders in this status.'),
      customerId: z.string().optional().describe('Only orders from this customer id.'),
      from: z.iso.datetime().optional().describe('Placed at or after this time (ISO 8601).'),
      to: z.iso.datetime().optional().describe('Placed before this time (ISO 8601).'),
      limit,
      page,
    }),
    execute: async (input, { signal }) => shapeOrderPage(await api.get('/orders', input, signal)),
  });

  const getOrder = defineTool({
    name: 'get_order',
    description:
      'Get one order by its order number: status, line items, totals in cents, customerId, and how much has been refunded.',
    safety: 'read',
    input: z.object({ orderNumber }),
    execute: ({ orderNumber }, { signal }) =>
      api.get(`/orders/by-number/${encodeURIComponent(orderNumber)}`, undefined, signal),
  });

  const getCustomer = defineTool({
    name: 'get_customer',
    description:
      "Get one customer's contact details, address, loyalty tier and notes. Use the customerId field from an order.",
    safety: 'read',
    input: z.object({
      customerId: z
        .string()
        .regex(/^[a-f0-9]{24}$/, 'must be a 24-character hex id')
        .describe('Customer id, as found in an order.'),
    }),
    execute: ({ customerId }, { signal }) => api.get(`/customers/${customerId}`, undefined, signal),
  });

  const listProducts = defineTool({
    name: 'list_products',
    description:
      'Search the product catalog. Returns sku, name, category, priceCents and active per product, ' +
      'plus total, hasMore and nextPage. If hasMore is true, call again with page = nextPage. Prices are in cents.',
    safety: 'read',
    input: z.object({
      search: z.string().optional().describe('Text to find in the product name, case-insensitive.'),
      category: z.enum(['electronics', 'home', 'outdoor', 'apparel', 'fitness']).optional(),
      active: z.boolean().optional().describe('true = on sale, false = discontinued.'),
      limit,
      page,
    }),
    execute: async (input, { signal }) =>
      shapeProductPage(await api.get('/products', input, signal)),
  });

  const requestRefund = defineTool({
    name: 'request_refund',
    description:
      'Request a refund for a shipped or delivered order. This creates a PENDING refund: no money moves ' +
      'until the store owner approves it. The amount cannot exceed what is left to refund on the order.',
    safety: 'write',
    input: z.object({
      orderNumber,
      amountCents: z
        .number()
        .int()
        .positive()
        .describe('Refund amount in cents, for example 2499 for $24.99.'),
      reason: z.enum(['damaged', 'not_as_described', 'late_delivery', 'changed_mind', 'other']),
    }),
    // The API wants the order's internal id, which the model never sees, so look it up first.
    execute: async ({ orderNumber, amountCents, reason }, { signal }) => {
      const order = await api.get(
        `/orders/by-number/${encodeURIComponent(orderNumber)}`,
        undefined,
        signal,
      );
      const parsed = z.object({ _id: z.string() }).safeParse(order);
      if (!parsed.success) {
        throw new ToolExecutionError('internal', `Order ${orderNumber} came back without an id`);
      }
      return api.post('/refunds', { orderId: parsed.data._id, amountCents, reason }, signal);
    },
  });

  return [listOrders, getOrder, getCustomer, listProducts, requestRefund];
}
