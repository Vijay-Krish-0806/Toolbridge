# ADR-0027: Identity for embedded chat: token exchange, stream auth, user delegation

- **Status:** Proposed (design only; built with Step 4.4)
- **Date:** 2026-11-22

## Context

End users should chat inside the host app, not only in ToolBridge's own UI. The person is then signed in to the host, not to ToolBridge, yet ToolBridge needs a role it can trust (ADR 0026) and, later, may act on the host with that person's own permissions. A browser must never be able to claim a role, and no secret may reach the browser.

Current code (checked 2026-11-22): host credentials are bound when tools are created (`createOpenApiTools({ auth })`). The platform tool-call endpoint builds tools per request from the tenant's stored, envelope-encrypted credential (ADR 0020); the CLI and MCP server build them once per process. `ToolContext` carries only an abort signal. So no per-user credential can reach a host call today.

## Decision (proposed)

1. **Token exchange.** The host's backend, authenticated with its tenant API key, asks ToolBridge for a session for one of its users. ToolBridge returns a signed, short-lived session token with claims `tenant`, `sub` (host user id), `role`, `exp`, `jti` (unique id, so a token can be revoked and replay detected) and `aud` (the ToolBridge run API). The role comes from the host's server, never from the browser.
2. **Host user tokens stay server-side.** If the host also passes the user's own API token, ToolBridge stores it envelope-encrypted with a short TTL, keyed by session. It is never placed inside the browser-visible session token.
3. **Run stream auth (4.4).** No tokens in query strings (they leak into logs and history). Streams use fetch-based streaming with `Authorization: Bearer <session token>`, or a single-use, short-lived stream ticket. CORS allows only the tenant's configured origins.
4. **User delegation (later step).** A per-run credential source: the executor passes it to the tool through `ToolContext`, and generated tools use it in place of the creation-time `AuthProvider`. The service credential remains the default.

Estimated size of item 4: one composite `AuthProvider`, an optional field on `ToolContext` and `RunOptions`, one line in generated tools, and the session lookup in the platform; about half a step. Token expiry during long waits is ADR 0028.

## Alternatives considered

- **Browser sends its role or host token directly.** Rejected: any user could claim any role, and the host token would be exposed to scripts on the page.
- **Users log in to ToolBridge.** Rejected as the only path: every app is adding its own built-in assistant; a second login is poor product fit.
- **EventSource with the token in the URL.** Rejected: URLs end up in proxy logs, history and referrers.

## Consequences

- **Positive:** the agent code needs no change: it already takes a `principal` in run context (ADR 0026). Roles stay verifiable and secrets stay on servers.
- **Negative:** a signing key to manage and rotate; per-tenant CORS configuration; one more encrypted store with expiry.
- **Open:** signing algorithm and key rotation, token lifetime, revocation list storage. To be settled with Step 4.4.
