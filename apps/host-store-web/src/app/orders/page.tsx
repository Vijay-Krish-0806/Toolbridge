import Link from 'next/link';
import { redirect } from 'next/navigation';

import { StatusPill } from '../../components/status-pill';
import { currentStaff, hostFetch, money, type Order, ORDER_STATUSES } from '../../lib/host';

/** The orders list, read from the host API as the signed-in user, optionally of one status. */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  if (!(await currentStaff())) redirect('/login');
  const query = await searchParams;
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const status = ORDER_STATUSES.find((s) => s === query.status);
  const list = await hostFetch<{ items: Order[]; total: number; limit: number }>(
    `/orders?page=${String(page)}&limit=20${status ? `&status=${status}` : ''}`,
  );
  /** A link to a page of the list, keeping the filter. */
  const link = (toPage: number): string =>
    `/orders?page=${String(toPage)}${status ? `&status=${status}` : ''}`;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Orders</h1>
        <p className="text-sm text-slate-500">{list.total} orders</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {[undefined, ...ORDER_STATUSES].map((s) => (
          <Link
            key={s ?? 'all'}
            href={s ? `/orders?status=${s}` : '/orders'}
            prefetch={false}
            aria-current={s === status ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 capitalize ${s === status ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-100'}`}
          >
            {s ?? 'all'}
          </Link>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="text-left text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Placed</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((order) => (
              <tr key={order._id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono text-xs">
                  <Link href={`/orders/${order.number}`} className="text-teal-800 hover:underline">
                    {order.number}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill status={order.status} />
                </td>
                <td className="px-4 py-2.5 text-slate-500">{order.placedAt.slice(0, 10)}</td>
                <td className="px-4 py-2.5 text-right">{money(order.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="flex justify-between text-sm">
        {page > 1 ? <Link href={link(page - 1)}>Previous</Link> : <span />}
        {page * list.limit < list.total && <Link href={link(page + 1)}>Next</Link>}
      </nav>
    </section>
  );
}
