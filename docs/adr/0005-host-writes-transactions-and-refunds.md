# ADR-0005: Host store writes use conditional updates inside transactions; refunds take two steps

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The host store's write endpoints change several documents at once: creating an order reserves stock for each item, counts a coupon use and inserts the order; shipping removes stock and changes the order; rejecting a refund changes the refund and the order's committed refund total. Requests can overlap (two staff, or an agent retrying), and a request can fail halfway. The data must never show reserved stock for an order that does not exist, a coupon used past its limit, an order cancelled twice, or refunds that exceed the order total. The MongoDB deployment (Atlas Local 8.0) runs as a single-node replica set, so multi-document transactions are available.

Refunds are the riskiest write. ToolBridge's later approval step (Step 4.3) needs a real business rule to enforce.

## Decision

Every write runs in a MongoDB transaction (`connection.transaction`), and the transaction also writes an audit event. State changes are conditional atomic updates that match only the allowed starting state, for example `findOneAndUpdate({ _id, status: { $in: ['pending', 'paid'] } }, ...)`. A miss is reported as 404 (no such record) or 409 Conflict (wrong state). Limits that span requests are kept as counters on the parent document and checked in the same update: the order's `refundCommittedCents` (pending plus completed refunds) must stay at or below `totalCents`.

Refunds take two steps: support or owner requests a refund (pending, and its amount counts against the order at once); only the owner approves (completed) or rejects (released).

## Alternatives considered

### Single-document atomic updates only, no transactions

- Simpler, with no session passing.
- Not chosen: a failure between steps (for example, after reserving stock for the first item) would leave partial changes behind with no automatic undo.

### Read, check in code, then write

- The most familiar style: load the order, sum its refunds, insert if allowed.
- Not chosen: two concurrent requests can both pass the check and both write (a race), because the check and the write are separate steps.

### One-step refunds with a role-based amount limit

- Support refunds up to a threshold directly; larger refunds need the owner.
- Not chosen for the host app: the approval rule belongs to ToolBridge's policy layer (Step 4.3). A two-step flow in the host API keeps the money movement explicit.

## Consequences

**Positive**

- Changes and their audit records commit together or not at all. A failed order leaves no stock reserved (verified: a two-line order whose second line lacked stock left the first line's stock untouched).
- Double actions (cancel twice, approve twice) fail with 409 instead of corrupting state.
- The seed keeps reserved stock and refund totals consistent with orders.

**Negative**

- Every write passes a session through each query, which adds code and is easy to forget.
- Transactions require a replica set; a plain standalone MongoDB would reject them.
- `refundCommittedCents` is a denormalized counter that must change whenever a refund is requested or rejected.
- Order and tracking numbers come from "highest so far plus one". Two orders created at the same instant could clash; the unique index rejects one and its transaction rolls back, so the caller must retry.

**Follow-ups**

- Step 4.5 (idempotency keys) at the ToolBridge layer, so an agent retry after a timeout does not create a second order or refund.

## References

- Mongoose `Connection.prototype.transaction()`: https://mongoosejs.com/docs/api/connection.html
- ADR-0003 (host data layer), ADR-0004 (auth)
