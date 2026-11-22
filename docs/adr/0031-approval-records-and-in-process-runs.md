# ADR-0031: Approval records and in-process runs

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.3 session (a) gave the graph an approval gate (`interrupt()`), durable runs (`startAgentRun` / `resumeAgentRun`) and a MongoDB checkpointer (ADR 0030). Session (b) puts them behind the platform API, so a person can see a paused write and approve or reject it. There is no worker until Step 4.4a, and approvers are identified by a caller-supplied id until Step 4.4b (ADR 0029).

Constraints from the build plan:

- No write runs before approval, and resuming never runs the same write twice. A double click or two approvers at once must not mean two refunds.
- The approval node is side-effect free, because LangGraph runs a resumed node again from its start (LangGraph.js interrupts docs, checked 2026-11-22).
- An approver cannot approve their own high-risk request.
- Run context is never checkpointed, so the identity must be stored by us and supplied again on resume.

## Decision

**Runs execute in the background inside `toolbridge-api`, with two records next to LangGraph's checkpoints: a run record and an approval card. A card is decided by one atomic conditional update.**

- **Endpoints** (tenant API key): `POST /runs` returns 202 with a run id; `GET /runs/:id` gives status (`running`, `waiting_for_approval`, `completed`, `failed`), answer and stop reason; `GET /approvals?status=pending`; `POST /approvals/:id/approve` and `/reject` with `{ approverId, reason? }`, both returning 202.
- **Run record** (`runs`, `_id` = UUID = LangGraph `thread_id`): tenant, spec, message, principal `{userId, role}`, `credentialMode: 'service'`, status, result. The principal comes from here on resume.
- **Approval card** (`approvals`): created by the API when it sees the pause, outside the graph, with every call of the turn and its exact arguments, the strictest level and the requester.
- **Decided once:** `findOneAndUpdate({ _id, tenantId, status: 'pending' }, { $set: decision })`. When two requests race, only one still matches; the other gets 409, and only the winner resumes the run. A new `TenantScoped.findOneAndUpdate` keeps the tenant filter automatic.
- **Order of a decision:** read the card (404 or 409); refuse a self-approval of a `high` card (403); rebuild the run's tools and identity (this can fail, for example with no connection, and then the card stays pending); then the atomic update; then resume. Rejecting your own request is allowed, because withdrawing a write is always safe.
- **Two guards for "never twice":** this API guard, plus the graph's own refusal to resume a run that is not waiting. Self-approval is likewise checked by the API and again inside the graph.
- **Dependencies are rebuilt per leg:** tools (the spec's enabled, active tools with the stored connection), the authorizer and the approval rules are built from the database when a run starts and again when it resumes, so a tool disabled during the wait is not offered after it.
- **Restart rule:** on startup every run still `running` is marked `failed`, because in-process runs cannot outlive the process. Waiting runs are untouched and can be approved after a restart. On shutdown the API waits for running legs to finish writing.
- **Policy:** the platform file `PLATFORM_POLICY_FILE` (default `specs/host-store.policy.json`), validated at startup, until Step 4.3b stores one per spec.

## Alternatives considered

- **Queue the run now (BullMQ).** Not chosen: Step 4.4a adds the worker and its queue. In-process keeps this step about approvals; the endpoint contract (202 plus a status endpoint) stays the same when the queue arrives.
- **Read, check, then write the decision.** Not chosen: two requests can both read `pending` and both resume. A conditional update makes the database the arbiter.
- **A lock (Redis or a lock document) around the resume.** Not chosen: more moving parts, and it still needs the pending-to-decided state for the audit trail. The conditional update is the lock.
- **Create the card inside the graph node.** Not chosen: the node runs again on resume, so a write there would create a second card. Writing it outside the graph, when the pause is seen, keeps the node side-effect free.
- **Use only the checkpoint as the source of truth for status.** Not chosen: the API needs tenant-scoped queries ("pending cards of this tenant"), the principal, and failure reasons, which checkpoints do not hold.

## Consequences

- **Positive:** a 202 contract the worker can keep; one write per card, shown by an e2e race test (two parallel approvals give 202 and 409, one write) and a restart test (approve after a new app instance, one write; a second approval is 409); cards carry exact arguments for the inbox UI (U3).
- **Negative:** correct only with **one API instance** (the startup sweep would fail runs another instance is executing). If the process dies after the card is decided but before the resume is recorded, the run is marked failed on restart while the card says approved; Step 4.5 idempotency keys make a retry safe. Every write turn needs its own card: in the live check the model first called the refund with an order number, the API refused it, and the corrected call needed a second approval.
- **Follow-ups:** 4.4a replaces in-process legs with a queue and the startup sweep with job state; 4.4b takes `principal` and `approverId` from verified session tokens; 4.10 writes an audit row for each tool call, linked to the decided card (ADR 0032; the decision itself stays in the approval record); 4.3b replaces the policy file. Shortcuts: no tool retrieval in API runs yet (every enabled, allowed tool is offered), and the store system prompt is used for every tenant.
