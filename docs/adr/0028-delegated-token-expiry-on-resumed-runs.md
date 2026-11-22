# ADR-0028: Delegated user token expiring while a run waits for approval

- **Status:** Accepted (option 0); validated in Step 4.4c, see ADR 0038
- **Date:** 2026-11-22

## Context

Step 4.3 will pause a run before a risky write and resume it after a person approves, possibly hours later and after a restart. If the run acts with the end user's own host token (user delegation, ADR 0027), that token may have expired by the time the run resumes. The write must still run with the right authority, and the result must stay traceable to a person and an approval (Step 4.10).

## Options

0. **Approver's fresh delegated identity (evaluate first).** The approved write runs under the approver's own, freshly delegated host token, captured when they approve. The audit record names both requester and approver. _For:_ no expiry problem (the token is minutes old), no host changes, and the host enforces the approver's permissions on the write. _Against:_ the write is attributed to the approver at the host, not the requester; the approver must hold the permission for the action; reads after the write still need the requester's identity or the run ends at the write.
1. **Refresh callback.** ToolBridge calls a tenant-configured endpoint on the host backend to get a fresh token for the user before resuming. _For:_ the action keeps the user's own authority. _Against:_ every host must build and secure the endpoint; the user may have lost the permission meanwhile (which is correct, but the run fails late).
2. **Service-credential fallback with audit.** Resume with the tenant's stored service credential and record in the audit log that delegation was replaced, with the approval id. _For:_ always works; no host changes. _Against:_ the host sees the service account, not the user; this is only safe when ToolBridge's own policy check (ADR 0026) is re-run at resume time and the approval names the exact arguments.
3. **Re-authentication.** Keep the run paused and ask the user (or approver) to sign in again; resume when a fresh token arrives. _For:_ strongest guarantee. _Against:_ adds a second wait; runs can stall.

## Decision

**Option 0: an approved write runs under the approver's fresh delegated identity.** Decided in Step 4.3 (2026-11-22); built and validated in Step 4.4c, because until then every run uses the service credential.

- The approver's own host token is captured when they approve (it is minutes old, so it has not expired) and is used for the approved batch only.
- The audit record names both the requester and the approver, and the credential that performed each write (Step 4.10).
- If the approver lacks the host permission for the action, the write fails safely at the host (for example HTTP 403). Nothing is retried under another identity; the run reports the failure to the model and the user.
- Two rules apply whatever happens: ToolBridge's policy check (ADR 0026) runs again when the batch executes, and an expired requester token is never refreshed silently.
- Options 1 and 3 are not chosen: there will be no host refresh flow for now, and re-authentication adds a second wait. Option 2 is not chosen: the host would see the service account instead of a person.

## Consequences

- **Positive:** no token-expiry problem on approval; no host changes; the host enforces the approver's permissions on the write.
- **Negative:** at the host, the write is attributed to the approver, not the requester; approvers must hold the permission for the actions they approve; reads after the write still need the requester's identity, or the run ends at the write. The audit log is the record of who asked.
- Related: the 4.3 rule that the user who triggered a high-risk action cannot approve it (ADR 0026 follow-ups).
