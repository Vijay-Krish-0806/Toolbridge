# ADR-0015: HTTP executor for generated tools: auth as a port, and an SSRF-safe client

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Step 2.3a makes the tools compiled in 2.2 callable. A tool call's URL comes from a spec (possibly uploaded by a tenant) and its path and query values come from the model, so both are untrusted. Facts found while building:

- Phase 1's `ToolExecutor` already validates arguments, applies timeouts, retries reads only, and caps results. Generated tools should reuse it, not copy it.
- `z.fromJSONSchema` exists in zod 4.6.7 and enforces patterns, integers, ranges, unknown keys and nullable enums (checked by experiment). Its own type comment calls it "semi-experimental".
- Node 24 `http.request` connects to the address returned by a custom `lookup` and calls it with `{ all: true }` (experiment). It does not follow redirects (got the 302).
- **Pooled sockets skip the lookup.** With keep-alive on (Node's default), a second request reused the first socket, and a blocking lookup was never called. A per-request check is therefore not enough.
- Node skips DNS lookup for IP literals, so those must be checked before connecting.
- `net.BlockList` matches IPv4-mapped IPv6 (`::ffff:10.0.0.1`) against IPv4 rules.

## Decision

1. The executor lives in `agent-core/src/openapi/`. `createOpenApiTools` turns each `ToolDefinition` into an ordinary agent-core `Tool` (Zod input from `z.fromJSONSchema`, plus the original JSON Schema in a new optional `Tool.parameters` so the model sees the schema unchanged).
2. `request.ts` (pure) picks the variant and builds the request. Path values are percent-encoded; `.`, `..` and empty values are refused; the final URL must stay on the base origin.
3. Auth is a port: `AuthProvider.secretFor(scheme)`; `applyAuth` applies bearer, basic, apiKey (header, query, cookie) and oauth2/openIdConnect as bearer, choosing the first security alternative it can fully satisfy. Adapters: `StaticCredentials` (config token or a caller's own token) and `TokenLogin` (login, cache, re-login once after a 401).
4. `SafeHttpClient` (node:http/https, no new dependency) refuses non-http(s), blocked IP literals, and hostnames that resolve to private, loopback, link-local, CGNAT, multicast or reserved addresses. The check runs **inside the DNS lookup of the client's own connection pool**, so every pooled socket was checked when it was opened. Allowlisted hosts use a separate pool. No redirects; 5 MiB response cap.
5. Error mapping uses the API's own message (NestJS `message`, `error`, RFC 7807 `title`/`detail`); 429 and 5xx are retryable. A new `blocked` error code marks safety refusals.

## Alternatives considered

### A new package for the executor

- Clear boundary.
- Not now: agent-core already owns `Tool` and `ToolExecutor`; a package for five files adds wiring without a second user. Revisit when the MCP server (2.5) needs it.

### Global fetch with a pre-request DNS check

- Less code.
- Rejected: checking DNS and then connecting are two lookups (DNS rebinding can answer differently the second time), and fetch's pool reuses sockets. Pinning addresses in fetch needs the `undici` package as a new dependency.

### Ajv for argument validation

- The reference JSON Schema validator, already a transitive dependency.
- Not chosen: `ToolExecutor` is built on Zod, and `z.fromJSONSchema` passed our checks. If it misbehaves, swap the converter in one place.

## Consequences

**Positive**

- Generated tools return byte-identical data to the hand-written ones and go through the same failure paths (35 checks in `openapi:check`).
- Private addresses, cloud metadata (169.254.169.254), `localhost` via DNS, IPv6 loopback and `..` path values are refused; a security test keeps it so.
- A new auth method (tenant credentials in 2.6) is one new `AuthProvider`.

**Negative**

- Results are not shaped yet: `orders_list` returns 2,190 characters against 526 from the hand-shaped tool (2.3b).
- `z.fromJSONSchema` is semi-experimental.
- Form bodies support flat fields only (no Stripe-style `a[b]=` nesting); other content types error clearly.
- The host's `orders_get` uses `requiredArgs` order to pick a variant; if both id and number are given, the id wins.

**Follow-ups**

- 2.3b: result shaping (field allowlists, pagination hints) and a short agent run with the generated tools.
- 2.6: a tenant-credential `AuthProvider` and a per-tenant allowlist instead of a code argument.

## References

- ADR 0008 (executor errors and retries), ADR 0011 (context budget), ADR 0014 (tool generation).
- Node.js 24 docs: `http.request` options, `net.BlockList`, `dns.lookup`.
