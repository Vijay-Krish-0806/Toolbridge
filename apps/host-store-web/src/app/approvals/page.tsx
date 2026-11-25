import Link from 'next/link';
import { redirect } from 'next/navigation';

import { decideApproval } from '../../lib/actions';
import { callArguments, describeCall } from '../../lib/describe-call';
import { currentStaff } from '../../lib/host';
import { type ApprovalCall, type ApprovalCard, listApprovals } from '../../lib/toolbridge';

/** What to show after a decision. Fixed texts: nothing from the address bar is shown as it is. */
const RESULTS: Record<string, { text: string; ok: boolean }> = {
  approved: { text: 'Approved. The assistant continues with this request.', ok: true },
  rejected: { text: 'Rejected. Nothing was changed.', ok: true },
  decided: { text: 'Someone has already decided this request.', ok: false },
  forbidden: { text: 'You may not approve this request.', ok: false },
  gone: { text: 'This request does not exist (any more).', ok: false },
  failed: { text: 'The decision could not be saved. Please try again.', ok: false },
};

const TABS = ['pending', 'approved', 'rejected'] as const;
/** Decided cards are only shown for a look back. */
const MAX_DECIDED = 20;

/** The approval inbox (U3): every write that waits for a person, with its exact arguments. */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; tab?: string }>;
}) {
  const staff = await currentStaff();
  if (!staff) redirect('/login');
  const { result, tab: wanted } = await searchParams;
  const tab = TABS.find((t) => t === wanted) ?? 'pending';
  const message = result !== undefined && Object.hasOwn(RESULTS, result) && RESULTS[result];
  let cards: ApprovalCard[] | null;
  try {
    cards = await listApprovals(tab);
    if (tab !== 'pending') cards = cards.slice(-MAX_DECIDED).reverse();
  } catch {
    cards = null;
  }
  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Approvals</h1>
          <p className="text-sm text-slate-500">
            The assistant pauses here before it changes anything. You see the exact call.
          </p>
        </div>
        <Link
          href={`/approvals?tab=${tab}`}
          prefetch={false}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Refresh
        </Link>
      </div>
      <div className="flex gap-2 text-sm">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/approvals?tab=${t}`}
            prefetch={false}
            aria-current={t === tab ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 capitalize ${t === tab ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-100'}`}
          >
            {t}
          </Link>
        ))}
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
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          {tab === 'pending' ? 'Nothing is waiting.' : 'Nothing here yet.'}
        </p>
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
    <article
      className={`space-y-3 rounded-xl border bg-white p-4 ${high ? 'border-red-200' : 'border-slate-200'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${high ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}
        >
          {high ? 'HIGH RISK' : 'NEEDS APPROVAL'}
        </span>
        <span className="text-xs text-slate-500">
          asked by <strong>{isMine ? 'you' : card.requesterId}</strong>, {time(card.createdAt)}
        </span>
      </div>
      {card.exposure === 'flagged' && (
        <p className="rounded-lg bg-red-50 p-2 text-sm text-red-800">
          Warning: the assistant read text that looks like instructions. Check that you really want
          exactly this.
        </p>
      )}
      {card.calls.map((call) => (
        <Call key={call.id} call={call} />
      ))}
      {card.status === 'pending' ? (
        <Decision card={card} isMine={isMine} />
      ) : (
        <p className="text-sm text-slate-600">
          <span className="capitalize">{card.status}</span> by <strong>{card.approverId}</strong>
          {card.decidedAt && <>, {time(card.decidedAt)}</>}
          {card.reason && <>: {card.reason}</>}
        </p>
      )}
    </article>
  );
}

/** One call: our title, the tool, and the exact arguments that will be sent. */
async function Call({ call }: { call: ApprovalCall }) {
  const title = await describeCall(call);
  const args = callArguments(call);
  const rows: [string, string][] = args
    ? Object.entries(args).map(([name, value]) => [
        name,
        typeof value === 'string' ? value : JSON.stringify(value),
      ])
    : [['arguments', call.arguments]];
  return (
    <div className="text-sm">
      {title && <p className="font-semibold">{title}</p>}
      <p className={`font-mono text-xs ${title ? 'text-slate-500' : 'font-semibold'}`}>
        {call.name}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-slate-500">{name}</dt>
            <dd className="break-all whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-slate-500">Why: {call.reason}</p>
    </div>
  );
}

/** The reason field and the buttons of a waiting card. */
function Decision({ card, isMine }: { card: ApprovalCard; isMine: boolean }) {
  return (
    <form action={decideApproval} className="flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="approvalId" value={card.id} />
      <input
        name="reason"
        maxLength={1000}
        placeholder="Reason (optional)"
        aria-label="Reason"
        className="min-w-48 flex-1 rounded-lg border border-slate-300 px-3 py-2"
      />
      {card.level === 'high' && isMine ? (
        <span className="text-slate-500">Someone else must approve this.</span>
      ) : (
        <button
          name="decision"
          value="approve"
          className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800"
        >
          Approve
        </button>
      )}
      <button
        name="decision"
        value="reject"
        className="rounded-lg border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-100"
      >
        {isMine ? 'Withdraw' : 'Reject'}
      </button>
    </form>
  );
}

/** Before -> after: '2026-11-25T14:02:33.120Z' -> '2026-11-25 14:02 UTC'. */
function time(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}
