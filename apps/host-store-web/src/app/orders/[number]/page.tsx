import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { StatusPill } from '../../../components/status-pill';
import { requestRefund } from '../../../lib/actions';
import { currentStaff, HostError, hostFetch, money, type Order } from '../../../lib/host';

const REASONS = ['damaged', 'not_as_described', 'late_delivery', 'changed_mind', 'other'];

/** One order, and the refund button (the host decides whether this user may refund). */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ refund?: string }>;
}) {
  if (!(await currentStaff())) redirect('/login');
  const { number } = await params;
  const { refund } = await searchParams;
  let order: Order;
  try {
    order = await hostFetch<Order>(`/orders/by-number/${encodeURIComponent(number)}`);
  } catch (error) {
    if (error instanceof HostError && error.status === 404) notFound();
    throw error;
  }
  return (
    <section className="max-w-2xl space-y-4">
      <Link href="/orders" className="block text-sm text-teal-800 hover:underline">
        All orders
      </Link>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h1 className="text-lg font-semibold">
          {order.number} <StatusPill status={order.status} />
        </h1>
        <ul className="mt-3 text-sm">
          {order.items.map((item, i) => (
            <li key={i}>
              {item.quantity} x {item.name} at {money(item.unitPriceCents)}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          Total <strong>{money(order.totalCents)}</strong>
        </p>
      </div>
      <form
        action={requestRefund}
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      >
        <h2 className="font-semibold">Request a refund</h2>
        {refund && (
          <p className={`text-sm ${refund === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
            {refund === 'ok' ? 'Refund requested.' : `Refused: ${refund}`}
          </p>
        )}
        <input type="hidden" name="orderId" value={order._id} />
        <input type="hidden" name="number" value={order.number} />
        <label className="block text-sm">
          Amount (cents)
          <input
            name="amountCents"
            type="number"
            min={1}
            defaultValue={order.totalCents}
            className="mt-1 block w-full rounded-lg border border-slate-300 p-2"
          />
        </label>
        <label className="block text-sm">
          Reason
          <select
            name="reason"
            className="mt-1 block w-full rounded-lg border border-slate-300 p-2"
          >
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800">
          Request refund
        </button>
      </form>
    </section>
  );
}
