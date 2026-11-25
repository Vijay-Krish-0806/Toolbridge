# ADR-0053: Normal writes can be approved in the chat; titles on cards are built by our code

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

The owner shared mockups of the store with the assistant. They put Approve and Reject buttons in the chat and a plain title on each card. Until now the chat only said "waiting for approval", and the inbox (ADR 0051) showed ids. The rules already allow a requester to approve their own `required` card; only `high` needs someone else (ADR 0031, 0047).

## Decision

- **The widget shows Approve and Reject on `required` cards** and calls the approvals API with the session token it already has. A `high` card has no buttons. ToolBridge checks the role, the level and "decided once" again (ADR 0051), so a tampered page gains nothing.
- The exact arguments are on the card, not folded away. Buttons lock on the first click and disappear as soon as the run goes on, also when someone decided in the inbox. A refusal that cannot change (403, 404, 409) leaves them locked.
- **The inbox title is built by the store's code** from the exact arguments ("Request a refund of $150.00 on order ORD-10028"), with the order number read from the host as the approver. The model never writes it: a fooled model could describe something else than what runs. Unknown tools and odd arguments get no title, only the tool name and the arguments.
- The widget itself shows tool names: it works for any API and knows none.
- **Same-origin check of the session route:** the `Origin` is compared with the `Host` header instead of `request.url`.

## Alternatives considered

### No approval in the chat

- One place to decide.
- Not chosen: the requester may approve a normal write anyway, and leaving the chat for it invites blind clicking in the inbox.

### A title written by the model

- Nicer sentences, for any tool.
- Not chosen: the approver would read the attacker's text.

### Titles in the spec's overrides file

- Right for hosts that cannot change their page.
- Not chosen now: four titles in the demo store are enough.

## Consequences

**Positive**

- Ask, check and approve a normal write in one place. The inbox reads like a sentence and still shows the exact call.
- The first run in a real browser found a bug of Step 7.0: opened at `127.0.0.1`, the chat was refused as cross-site. Scripts send no `Origin`, so they could not see it. Wrong origins are still refused (five kinds tried).

**Negative**

- One more place for approval fatigue: one click in the chat is easy. High-risk and flagged requests still need another person.
- A card is not shown again after a page reload; the inbox has it.
- A title costs one host read per card, and an order the approver may not read shows its id.

## References

- ADR 0031, 0039, 0047, 0051. Next.js [data security](https://nextjs.org/docs/app/guides/data-security) (Origin against Host), read 2026-11-25.
