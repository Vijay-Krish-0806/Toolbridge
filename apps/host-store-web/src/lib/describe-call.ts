/**
 * A plain title for a call on an approval card, such as "Request a refund of $150.00 on order
 * ORD-10028". Built by OUR code from the exact arguments, never by the model: a fooled model could
 * describe something else than what runs. The exact arguments are always shown below it.
 */
import { hostFetch, money, type Order } from './host';
import type { ApprovalCall } from './toolbridge';

/** The arguments as an object, or undefined when the model wrote something else. */
export function callArguments(call: ApprovalCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The title of one call, or undefined when we have none for it (the tool name is then enough).
 * Before -> after: refunds_request `{ orderId: '6ac…', amountCents: 15000 }` ->
 * "Request a refund of $150.00 on order ORD-10028".
 */
export async function describeCall(call: ApprovalCall): Promise<string | undefined> {
  const args = callArguments(call);
  if (!args) return undefined;
  switch (call.name) {
    case 'refunds_request':
      if (typeof args.amountCents !== 'number') return undefined;
      return `Request a refund of ${money(args.amountCents)} on order ${await orderName(args.orderId)}`;
    case 'orders_cancel':
      return `Cancel order ${await orderName(args.id)}`;
    case 'orders_mark_paid':
      return `Mark order ${await orderName(args.id)} as paid`;
    case 'orders_update_notes':
      return `Replace the notes on order ${await orderName(args.id)}`;
    default:
      return undefined;
  }
}

/** The order's number, read from the host as the signed-in approver; the id when that fails. */
async function orderName(id: unknown): Promise<string> {
  // The id becomes part of a URL, and it comes from the model: only a real id may pass.
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) return '(unknown)';
  try {
    return (await hostFetch<Order>(`/orders/${id}`)).number;
  } catch {
    return id;
  }
}
