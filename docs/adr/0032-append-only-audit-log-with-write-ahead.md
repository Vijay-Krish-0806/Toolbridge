# ADR-0032: Append-only audit log with write-ahead rows for writes

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.10 asks for an append-only record per tool call (host user, role, credential mode, arguments hash, result status, approval with requester and approver, run id) and a query API, so that any write can be traced to a person and an approval. Tool calls reach a tenant's API on two paths: agent runs (Step 4.3, through `ToolExecutor` inside the graph) and the direct tool-call endpoint from Step 2.6b. The worker (4.4a) and delegated calls (4.4c) will add more callers of the same executor.

## Decision

**The executor reports every call to an audit port; the platform writes the rows to an append-only `auditentries` collection. A write runs only after its `started` row is saved.**

- **Port in agent-core** (`tools/audit.ts`): `ToolAuditor { started, finished }`, an optional `audit` option of `ToolExecutor`, like `authorizer`. agent-core stays free of the database (ports and adapters); every caller of the executor gets auditing by passing one adapter.
- **Write-ahead, fail closed:** for a write tool, `started` is awaited after the access and argument checks and right before the tool runs. If it throws, the write does not run and the model gets `audit_unavailable`. Every call (refused ones too) then gets one `finished` row with `ok` or the error code and the duration. Reads get only `finished`. If `finished` cannot be saved, the call has already happened, so the result still goes back and the lost row is logged as an error.
- **Row:** tenant, time, phase, run id (null for direct calls), call id, tool, safety, actor (`{kind:'user', userId, role}` or `{kind:'api_key', keyId}`), credential mode, `argsHash`, status, duration, approval `{id, level, requesterId, approverId}` or null.
- **`argsHash`:** sha256 of the exact argument string the model sent, which is the string on the approval card. Anyone can check that the write that ran is the one that was approved, and the audit log holds no customer data (names, addresses, amounts stay in the card and the host).
- **Approval link by call id:** a resumed leg gets the decided card; only the calls the card lists carry the approval, so reads the model makes later in the same leg are not shown as approved.
- **Append-only by construction:** `AuditLog` is the only code that touches the collection and it can only insert and query. Queries go through `TenantScoped`.
- **Query API:** `GET /audit` with `runId`, `toolName`, `userId`, `approvalId`, `safety`, `from`, `to`, `limit` (default 50, at most 200), newest first. Indexes `{tenantId, at}` and `{tenantId, runId, at}`.
- **Direct tool-call endpoint:** audited with the API key as the actor and no approval. Requiring approval there is on the v3 list (decided 2026-11-22: changing 2.6b now would break the scope freeze).

## Alternatives considered

- **One row per call, written after it runs.** Simpler, one row per call. Not chosen: if the process dies during a write, or the audit insert fails afterwards, a write happened with no record. The write-ahead row costs one extra insert per write only.
- **One row, inserted before and updated after.** Not chosen: an update breaks append-only, and a crash still leaves a half-written row; two immutable rows say the same thing honestly.
- **Store the raw arguments.** Not chosen: the audit log would become a second copy of customer data with a longer life than the run. The hash proves which arguments ran; the card (and later the run trace, U4) shows them to people allowed to see them.
- **Audit in the graph or the API instead of the executor.** Not chosen: the direct-call endpoint and the future worker would each need their own copy, and a missed path would be silent.
- **Database-enforced append-only now** (an insert-only MongoDB role, or a hash chain linking rows). Not chosen for now: local development connects as the root user, and a per-tenant hash chain needs ordered inserts while reads run in parallel. Both are on the v3 list.

## Consequences

- **Positive:** every write has a record before it runs, or it does not run (unit test: a failing write-ahead leaves the tool run count at 0); a write is traceable to user, role, card, requester and approver (e2e, and the test fails when the approval stamp is removed); one adapter covers every executor caller; other tenants see no rows (e2e).
- **Negative:** append-only is a code rule, not a database rule, so anyone with database access can still change rows; one extra insert per write; a crash between `started` and `finished` leaves a write without a known outcome (that is exactly the case the `started` row exists to show, and Step 4.5 idempotency keys make a retry safe); direct calls trace to a key, not a person. Calls refused before the executor (a tool that was not offered to the run) are not audited; they never reach the API.
- **Follow-ups:** 4.4c records `credentialMode: 'delegated'` and the user whose token was used; U4 run trace reads these rows; v3 list: approval for direct-call writes, database-level append-only.
