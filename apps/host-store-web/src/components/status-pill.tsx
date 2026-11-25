const COLORS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800',
  paid: 'bg-sky-50 text-sky-800',
  shipped: 'bg-indigo-50 text-indigo-800',
  delivered: 'bg-green-50 text-green-800',
  cancelled: 'bg-slate-100 text-slate-600',
};

/** An order's status as a colored label. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${COLORS[status] ?? 'bg-slate-100 text-slate-600'}`}
    >
      {status}
    </span>
  );
}
