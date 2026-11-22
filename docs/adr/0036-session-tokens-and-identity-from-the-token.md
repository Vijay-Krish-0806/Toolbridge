# ADR-0036: Session tokens, and identity only from the token

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

ADRs 0027 and 0029 decided the identity model: the host's backend exchanges its tenant API key for a short-lived signed session token per host user (tenant, user id, role, exp, jti, audience); every caller, approvers included, is a host user; ToolBridge has no accounts. Until Step 4.4b the run and approval APIs took the user and role from the request body, so any caller could claim any role. The 4.4b done-check requires tests that forged, expired, replayed and wrong-audience tokens are rejected and that a browser cannot choose its own role. This ADR covers session (a) of 4.4b: the tokens and how routes use them. CORS and the dev login (session b) are ADR 0037.

## Decision

**Session tokens are HS256 JWTs (jose 6.2.15) backed by a server-side record per `jti`. Run and approval routes accept only session tokens and take user, role and spec from them.**

- **Mint:** `POST /sessions` with the tenant API key: `{ specId, userId, role, ttlSeconds?, userToken? }`. The role must be a role of the spec's current policy (422 otherwise; a spec without a policy has no roles, so nothing can be minted). Lifetime 15 minutes by default, 60 s to 1 hour.
- **Claims:** `iss` `toolbridge`, `aud` `toolbridge-run-api`, `sub` (host user), `ten`, `spec`, `role`, `iat`, `exp`, `jti`. The payload is readable by anyone, so it carries no secret.
- **Verify:** only HS256 (so `alg: none` and other algorithms are refused before the signature), issuer, audience, expiry and every claim required. Then the server-side record must exist, be unrevoked and unexpired, and match the claims.
- **Record:** `sessions` (`_id` = jti) with tenant, spec, user, role, expiry, `revokedAt`, who minted it, and the optional host user token envelope-encrypted with AAD `tenant:<id>:session:<jti>` (used in Step 4.4c). A MongoDB TTL index deletes it when it expires. `DELETE /sessions/current` revokes the token (logout).
- **Routes:** `@SessionOnly()` on `/runs` and `/approvals` (session tokens only; the tenant API key gets 401 there). Everything else stays tenant-API-key only, including minting. `POST /runs` takes only `{ message }`; a `principal` or `specId` in the body is refused (400) by the strict validation pipe. The approver is the token's user, so "approver is not the requester" compares two `sub` claims from verified tokens.
- **Visibility:** with a session, a user sees and cancels only their own runs (a colleague's run is the same 404 as a missing one). The approval inbox and decisions are per spec: a card of another spec is "not found" for the session. Cards now store their run's `specId`.
- **Failures:** every refusal is the same 401 message, so a caller cannot tell a forged token from an expired one.
- **Key:** `PLATFORM_SESSION_KEY`, base64 of exactly 32 bytes, validated at startup like the master key; the `.env.example` placeholder is invalid on purpose.

## Alternatives considered

- **Opaque random tokens (only a database id).** Simple and revocable. Not chosen: every request needs the database anyway here, but a JWT also lets the host and the widget read who the token is for and when it expires without a call, and ADR 0027 asked for signed claims.
- **Pure stateless JWTs (no record).** One less read per request. Not chosen: no revocation before expiry, and nowhere safe to keep the host user's token for delegation.
- **Asymmetric signatures (EdDSA or RS256).** Needed when other services verify tokens with a public key. Not chosen now: only ToolBridge verifies its own tokens, and HS256 with one 256-bit secret is simpler; switching later changes one module.
- **Keep the API key on run routes for server-to-server callers.** Not chosen: the key would let any server code claim any user and role, which is what this step removes. A host backend mints a session per user instead.
- **Let approvers see every card of the tenant.** Not chosen: a session is for one spec (one host app's API and policy); per-spec inboxes match the policy boundary.

## Consequences

- **Positive (e2e, 14 cases):** a token signed with another key, a payload with the role raised, an expired token, another audience, `alg: none`, HS512, an unknown `jti`, and a token replayed after logout are all refused with the same 401; only policy roles can be minted, at most for an hour, only for the tenant's own specs; a body cannot set role, user or spec; the API key cannot start runs or approve; the host user token is not in the JWT, the response or the database in clear; a colleague cannot see another user's run; a session for one spec cannot see or decide another spec's cards; self-approval of a high-risk card is refused on the token's user. Removing the revocation check or the audience check makes a test fail.
- **Negative:** one database read per request for the session record (indexed by id); changing `PLATFORM_SESSION_KEY` logs everyone out (no key rotation list yet); a token stolen from a browser works until it expires or is revoked (hence the short lifetime).
- **Follow-ups:** session (b): per-tenant CORS origins, refusing the API key from a browser, and the dev-only login page with its required test (ADR 0037). Step 4.4c decrypts the stored host user token for delegated calls.
