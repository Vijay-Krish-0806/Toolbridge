# ADR-0051: The approval inbox is a page of the store, and a card is decided by someone who may use its tools

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

Runs pause before a write (ADR 0031), but there was no screen to decide, only the API. The build plan puts the inbox (U3) into a new console app, `apps/web`. Approvers are host users, already signed in to the store.

While planning it, a gap showed: any role with a session could list and decide every card of its spec. Only self-approval of `high` cards was refused. A warehouse user could read customer data in the arguments and approve a refund. In delegated mode the host then refuses the write (403) and the card is spent; in service mode the write would run.

## Decision

- **A page in `apps/host-store-web`** (`/approvals`): a Server Component lists the cards, a Server Action decides. The store's server mints the session and calls ToolBridge (backend for frontend), so no session token or API key reaches the browser. The chat's session route uses the same code.
- **The card shows** level, requester, every call with its exact arguments, the reasons, and the injection warning, as text only. Results of a decision are fixed texts, chosen by a code in the address.
- **Who may decide:** a person sees and decides a card only if the spec's policy of NOW lets their role use every tool on it. Otherwise it is a 404, as if it did not exist. The requester always sees their own card and may withdraw it, but may approve it only with that permission (403). The `high` rule stays. Tool names the spec never had do not count, since they cannot run; a card without any known tool is refused.

## Alternatives considered

### A console app (`apps/web`), as planned

- Right when operators of several hosts need one place.
- Not chosen: a whole app and a second sign-in for one screen. The plan's U1a, U2 and U4 would still belong there.

### The browser calls ToolBridge, like the chat widget

- Needed for live streaming.
- Not chosen: the inbox needs no stream, and this keeps tokens out of the page.

### A separate "approver" role or permission in the policy

- More exact: who may ask and who may approve can differ.
- Not chosen now: "may use the tool" is the rule the policy already has. It can be added to the policy format when a tenant needs it.

### Live updates

- Not chosen: a Refresh button is enough for a demo.

## Consequences

**Positive**

- The whole flow (ask, pause, approve, result in the chat) can be done in the browser.
- The permission holds in both credential modes and is tested (two e2e tests; 6 of 6 broken rules were noticed).

**Negative**

- An approver needs the tool themselves: a manager who may only approve cannot be expressed.
- Every page view creates a short-lived session record.
- Cards appear only after Refresh, and decided cards are not listed.
- The card shows ids (an order id, not the order number), so the approver may have to look the record up.

**Follow-ups**

- Link the records on a card, and a history of decisions (v3).

## References

- Next.js docs, read 2026-11-25: [mutating data](https://nextjs.org/docs/app/getting-started/mutating-data), [data security](https://nextjs.org/docs/app/guides/data-security), [redirect](https://nextjs.org/docs/app/api-reference/functions/redirect).
- ADR 0026 (roles), 0028 and 0038 (delegation), 0031 (approvals), 0036 (sessions), 0039 (store site), 0047 (injection).
