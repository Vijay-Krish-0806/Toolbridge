import Link from 'next/link';
import { redirect } from 'next/navigation';

import { decideApproval } from '../../lib/actions';
import { currentStaff } from '../../lib/host';
import { type ApprovalCall, type ApprovalCard, pendingApprovals } from '../../lib/toolbridge';

/** What to show after a decision. Fixed texts: nothing from the address bar is shown as it is. */
const RESULTS: Record<string, { text: string; ok: boolean }> = {
  approved: { text: 'Approved. The assistant continues with this request.', ok: true },
  rejected: { text: 'Rejected. Nothing was changed.', ok: true },
  decided: { text: 'Someone has already decided this request.', ok: false },
  forbidden: { text: 'You may not approve this request.', ok: false },
  gone: { text: 'This request does not exist (any more).', ok: false },
  failed: { text: 'The decision could not be saved. Please try again.', ok: false },
};

/** The approval inbox (U3): every write that waits for a person, with its exact arguments. */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const staff = await currentStaff();
  if (!staff) redirect('/login');
  const { result } = await searchParams;
  const message = result !== undefined && Object.hasOwn(RESULTS, result) && RESULTS[result];
  let cards: ApprovalCard[] | null;
  try {
    cards = await pendingApprovals();
  } catch {
    cards = null;
  }
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Approvals</h1>
        <Link
          href="/approvals"
          prefetch={false}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
        >
          Refresh
        </Link>
      </div>
      {message && (
        <p className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
      {cards === null && (
        <p className="text-sm text-red-700">The assistant is unavailable right now.</p>
      )}
      {cards?.length === 0 && (
        <p className="rounded-lg bg-white p-4 text-sm text-slate-500 shadow">Nothing is waiting.</p>
      )}
      {cards?.map((card) => (
        <Card key={card.id} card={card} isMine={card.requesterId === staff.email} />
      ))}
    </section>
  );
}

/**
 * One card. All its calls are decided together. The requester of a high-risk request gets no
 * Approve button; ToolBridge refuses it as well, so this only saves them a click.
 */
function Card({ card, isMine }: { card: ApprovalCard; isMine: boolean }) {
  const high = card.level === 'high';
  return (
    <article className="space-y-3 rounded-lg bg-white p-4 shadow">
      <p className="text-sm">
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${high ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}
        >
          {high ? 'HIGH RISK' : 'NEEDS APPROVAL'}
        </span>{' '}
        asked by <strong>{isMine ? 'you' : card.requesterId}</strong>,{' '}
        {card.createdAt.slice(0, 16).replace('T', ' ')} UTC
      </p>
      {card.exposure === 'flagged' && (
        <p className="rounded bg-red-50 p-2 text-sm text-red-800">
          Warning: the assistant read text that looks like instructions. Check that you really want
          exactly this.
        </p>
      )}
      {card.calls.map((call) => (
        <div key={call.id} className="rounded border border-slate-200 p-3 text-sm">
          <p className="font-mono font-semibold">{call.name}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs">
            {argumentRows(call).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-slate-500">{name}</dt>
                <dd className="break-all whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-500">Why: {call.reason}</p>
        </div>
      ))}
      <form action={decideApproval} className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="approvalId" value={card.id} />
        <input
          name="reason"
          maxLength={1000}
          placeholder="Reason (optional)"
          aria-label="Reason"
          className="min-w-48 flex-1 rounded border border-slate-300 p-2"
        />
        {high && isMine ? (
          <span className="text-slate-500">Someone else must approve this.</span>
        ) : (
          <button
            name="decision"
            value="approve"
            className="rounded bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800"
          >
            Approve
          </button>
        )}
        <button
          name="decision"
          value="reject"
          className="rounded border border-slate-300 px-4 py-2 font-medium hover:bg-slate-100"
        >
          {isMine ? 'Withdraw' : 'Reject'}
        </button>
      </form>
    </article>
  );
}

/**
 * The arguments as name and value rows; text that is not a JSON object is shown as it is, so an
 * approver always sees what will be sent.
 * Before -> after: `{"id":"6ae","reason":"x"}` -> `[['id', '6ae'], ['reason', 'x']]`.
 */
function argumentRows(call: ApprovalCall): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([name, value]) => [
        name,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]);
    }
  } catch {
    // Not JSON: shown as it is below.
  }
  return [['arguments', call.arguments]];
}
