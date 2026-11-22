# ADR-0037: Per-tenant CORS, no keys in browsers, and a dev-only login

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

From Step 4.4b the run API is called from web pages: the chat widget inside a host app (U1b, 7.0) and the console (U1a, U3). ADR 0027 requires CORS to allow only each tenant's configured origins, and ADR 0029 requires a dev-only console login page that mints a session token for a chosen host user and role. The build plan makes "the dev login is off outside development" a required test. Session (a) (ADR 0036) already moved runs and approvals to session tokens.

The difficulty with per-tenant CORS: before a cross-origin request that carries an `Authorization` header, the browser sends a PREFLIGHT (`OPTIONS`) with no credentials at all, so the server cannot yet know which tenant the page belongs to.

## Decision

**Check the origin twice: the preflight against all tenants, the real request against the token's own tenant. Refuse every key that arrives from a browser. Leave the dev login out of the app entirely unless `PLATFORM_ENV=development`.**

- **Setting:** `Tenant.allowedOrigins`, set with `PUT /tenant/origins` (tenant API key). Only bare http(s) origins are accepted (no path, trailing slash, wildcard or credentials); input is normalized (`https://Shop.Example` becomes `https://shop.example`), and anything else is a 400, never silently fixed. At most 20 per tenant. Empty means no browser access.
- **Preflight** (a middleware before any route): allowed when ANY tenant lists the origin (multikey index). The answer is 204 with the echoed origin (never `*`), `Vary: Origin`, methods GET, POST and DELETE, headers `authorization`, `content-type` and `last-event-id`, and a 10-minute max age. There is no `Allow-Credentials`: we use a bearer header, not cookies. An unknown origin gets 403 with no CORS headers.
- **Real request** (in the guard, after the token is verified): the token's tenant must list the origin, otherwise 403. Tenant B's token used from tenant A's shop is refused, even though the preflight passed. On success the response, the SSE stream included, carries the CORS headers.
- **No keys in browsers:** a tenant API key or the admin key on a request with an `Origin` header gets 403. Server-to-server calls send no `Origin` and are unchanged.
- **`PLATFORM_ENV`** (`development`, `test` or `production`), with `production` as the default when unset. `.env.example` sets `development` for local work; the test harness sets `test`.
- **Dev login** (`GET` and `POST /dev/login`): registered in `AppModule` only in development, so elsewhere the routes do not exist (404); the API logs a warning at startup when it is on. The page is self-contained (no external scripts, styles or fonts), with a CSP that allows only this response's nonce, `connect-src 'self'`, and no framing. `POST` checks the key with the same `ApiKeyVerifier` the guard uses, then mints through `SessionsService`, so only a role of the spec's policy can be chosen.
- **Fix found while testing:** the event stream waited for the client to leave with `events.once(req, 'close')`, which REJECTS when the socket emits `error` (a client that resets its connection mid-stream). Nothing awaited that promise, and an unhandled rejection stops a Node process by default. The stream now uses plain listeners that only resolve, and ignores the request's `error` event.

## Alternatives considered

- **One global allow-list of origins.** Simpler. Not chosen: any tenant's page could then use any other tenant's tokens from its origin; the per-tenant check on the real request is what makes the list mean something.
- **Answer every preflight with the echoed origin.** Not chosen: it tells any site it may try, and pushes the whole decision to the real request; refusing unknown origins at the preflight stops most cross-site attempts before a token is even sent.
- **A dev login checked by a flag at request time.** Not chosen: a forgotten or wrong check would expose the route. Not registering the controller means there is no route to reach.
- **A dev login protected by its own password.** Not chosen: it would be a second credential system. The tenant API key already proves who may mint, and the page exists only on a developer's machine.
- **Cookies for the browser session.** Not chosen: cookies need CSRF protection and SameSite rules, and the widget runs inside other companies' sites; a bearer header is sent only when our code chooses to.

## Consequences

- **Positive (e2e, 9 cases):** the dev login is a 404 with `PLATFORM_ENV=test` and `production`, and the default when unset is `production` (required test); in development it serves the page with a nonce CSP and mints by the same rules (bad key 401, unknown role 422); a preflight from an unknown origin is 403 with no CORS headers; a token works only from its own tenant's origins, including the cross-tenant case; a key from a browser is 403; the stream carries the CORS header; bad origin entries are 400.
- **Negative:** one extra database read per browser request (the tenant's origins; not cached yet); a preflight reveals whether some tenant lists an origin; a developer who sets `PLATFORM_ENV=development` on a shared server exposes the login page (logged loudly at startup).
- **Follow-ups:** U1a, U1b and U3 sign in through these tokens; Step 7.0's host web app mints sessions server-side and lists its origin.
