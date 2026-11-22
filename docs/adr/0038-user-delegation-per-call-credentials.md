# ADR-0038: User delegation with per-call credentials

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Until Step 4.4c every tool call reached the host API with the tenant's stored service credential, so the host saw one account for every user: ToolBridge's policy (ADR 0026) was the only permission check, and the host could not apply its own rules to the person behind a run. ADR 0027 decided a credential mode per tenant and sized the change (a per-call credential through the executor and the tool context). ADR 0028 decided, for long approval waits, that an approved write runs under the approver's own fresh identity (option 0), to be validated in this step. Step 4.4b added session tokens that can carry the host user's own token, stored encrypted.

## Decision

**A tenant runs in `service` or `delegated` mode. In delegated mode each call uses one person's own host token, chosen per call: the approver's for the calls of the card they approved, the requester's for every other call. A missing token refuses the call; nothing falls back.**

- **Setting:** `Tenant.credentialMode`, set with `PUT /tenant/credential-mode`. The default stays `service` so existing tenants keep working. In `delegated` mode, `POST /sessions` requires `userToken` (422 otherwise).
- **Fixed per run:** a run stores its mode and the requester's session id when it starts. Switching the tenant later never changes a run half-way. Starting needs a session with a usable token (422 otherwise).
- **Approvals:** the card stores the approving session's id; in delegated mode approving needs a session with a token (422 otherwise).
- **agent-core:** `ToolExecutor` gets a `credentialFor(call)` option; its result goes into `ToolContext.auth`, and generated tools use it instead of their creation-time credential. It runs after the access and argument checks and before the write-ahead audit row, so a refused call leaves no `started` row. `CredentialUnavailableError` becomes the new tool error `credential_unavailable`.
- **Platform:** `RunToolsService` picks the session per call and wraps the decrypted token as the credential for every HTTP bearer scheme of the API. `UserTokenStore` (shared with the worker) decrypts a session's token only at call time; a revoked, expired, token-less or undecryptable session (for example a ciphertext copied from another record, AAD `tenant:<id>:session:<jti>`) gives no token.
- **Both must allow:** ToolBridge's policy still filters the menu and checks every call first; the host then applies its own rules to that person's token, and its refusal (403) is returned to the model as it is.
- **Audit:** rows record `credentialMode` and `credentialUserId`, the host user whose token made the call. With the approval's requester and approver, the log answers who asked, who approved, and whose identity the host saw.

## Alternatives considered

- **Delegation as the default for new tenants.** The plan calls it the default for the embedded assistant. Not done now: it would break every existing setup and test that has no host tokens; the host turns it on per tenant (decided 2026-11-22).
- **One credential for the whole resumed leg (the approver's).** Simpler. Not chosen: reads after the approved write would run with the approver's rights, which may be wider than the requester's, a confused deputy in reverse.
- **Fall back to the service credential when a user's token is gone.** Keeps runs going. Not chosen: the host would see the service account act for a person who signed out, and ADR 0028 forbids silent identity changes.
- **Refresh the user's host token.** Not chosen (ADR 0028): no host refresh flow; a token lives as long as its session (at most an hour).

## Consequences

- **Positive (e2e, 6 cases):** under a policy that allows refunds for everyone, the same request files a refund for the owner and gets the host's 403 for warehouse, and the service key never reaches the host; an approved write runs with the approver's token, and the audit row names the token's user, the requester and the approver; an approver without the host permission makes the write fail safely, with exactly one attempt; a requester who logged out has their next call refused with `credential_unavailable` and nothing sent; delegated mode refuses sessions and approvals without a token; a copied ciphertext does not decrypt. Making the run fall back to the service key, or ignoring the approver's token, makes a test fail.
- **Negative:** at the host, an approved write is attributed to the approver (as ADR 0028 accepted); a run stops making calls once its requester's session ends (up to an hour after sign-in); only bearer schemes are delegated (an API with only API-key or basic auth keeps using the service credential's scheme, which a delegated session does not fill).
- **Follow-ups:** Step 7.0's host web app passes each user's host token when it mints a session; the widget (U1b) never sees it.
