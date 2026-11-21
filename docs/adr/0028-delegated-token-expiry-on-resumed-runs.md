# ADR-0028: Delegated user token expiring while a run waits for approval

- **Status:** Proposed (options recorded; not implemented)
- **Date:** 2026-11-22

## Context

Step 4.3 will pause a run before a risky write and resume it after a person approves, possibly hours later and after a restart. If the run acts with the end user's own host token (user delegation, ADR 0027), that token may have expired by the time the run resumes. The write must still run with the right authority, and the result must stay traceable to a person and an approval (Step 4.10).

## Options

1. **Refresh callback.** ToolBridge calls a tenant-configured endpoint on the host backend to get a fresh token for the user before resuming. *For:* the action keeps the user's own authority. *Against:* every host must build and secure the endpoint; the user may have lost the permission meanwhile (which is correct, but the run fails late).
2. **Service-credential fallback with audit.** Resume with the tenant's stored service credential and record in the audit log that delegation was replaced, with the approval id. *For:* always works; no host changes. *Against:* the host sees the service account, not the user; this is only safe when ToolBridge's own policy check (ADR 0026) is re-run at resume time and the approval names the exact arguments.
3. **Re-authentication.** Keep the run paused and ask the user (or approver) to sign in again; resume when a fresh token arrives. *For:* strongest guarantee. *Against:* adds a second wait; runs can stall.

## Decision

Not decided. To be chosen in Step 4.3. Whatever is chosen, two rules apply: the policy check runs again on resume, and the audit record says which credential performed the write.

## Consequences

- Choosing 1 or 3 needs host cooperation; choosing 2 needs per-tenant opt-in and clear audit fields.
- Related: the 4.3 rule that the user who triggered a high-risk action cannot approve it (ADR 0026 follow-ups).
