import Link from 'next/link';
import { redirect } from 'next/navigation';

import { currentStaff, hostFetch, money, type Order } from '../../lib/host';

/** The orders list, read from the host API as the signed-in user. */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  if (!(await currentStaff())) redirect('/login');
  const page = Math.max(1, Number((await searchParams).page ?? 1) || 1);
  const list = await hostFetch<{ items: Order[]; total: number; limit: number }>(
    `/orders?page=${String(page)}&limit=20`,
  );
  const hasMore = page * list.limit < list.total;
  return (
    <section className="rounded-lg bg-white shadow">
      <h1 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">Orders</h1>
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="px-4 py-2">Order</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((order) => (
            <tr key={order._id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2">
                <Link href={`/orders/${order.number}`} className="text-blue-700 hover:underline">
                  {order.number}
                </Link>
              </td>
              <td className="px-4 py-2">{order.status}</td>
              <td className="px-4 py-2 text-right">{money(order.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <nav className="flex justify-between px-4 py-3 text-sm">
        {page > 1 ? <Link href={`/orders?page=${String(page - 1)}`}>Previous</Link> : <span />}
        {hasMore && <Link href={`/orders?page=${String(page + 1)}`}>Next</Link>}
      </nav>
    </section>
  );
}
