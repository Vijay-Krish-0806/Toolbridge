# ADR-0018: MCP server over stdio and Streamable HTTP, on the official SDK v2

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Step 2.5 exposes the compiled tools through the Model Context Protocol, so any MCP host (Claude Code, Claude Desktop, IDEs, our own agent later) can use them without knowing about OpenAPI. Facts checked before building:

- The TypeScript SDK split into v2 packages: `@modelcontextprotocol/server` 2.4.0 (implements the 2026-07-28 spec), `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/node` 2.1.2. v1 (`@modelcontextprotocol/sdk` 1.32.2) is the legacy single package.
- `fromJsonSchema()` registers a plain JSON Schema unchanged; the SDK validates calls with AJV.
- Tool annotations (from the SDK source) are hints with cautious defaults: `readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true. Clients must not trust them from untrusted servers.
- `serveStdio` serves 2025-era clients by default; stdout is the protocol channel. `createMcpHandler` is stateless per request and validates neither Host nor Origin by itself.
- MCP Inspector 2.11+ needs Node 24.22.1 or later; 2.10.1 runs on Node 24.10.

## Decision

1. A new package, `packages/mcp-server`, on SDK v2. It compiles the spec through `compileSpec` and the file cache (ADR 0017) and runs every call through the existing `ToolExecutor` and HTTP layer (ADR 0015). Failures are returned as `isError` results, never protocol errors.
2. Annotations are derived from the tool: read tools are `readOnlyHint`; writes are destructive for PUT, PATCH, DELETE, a POST on an existing resource (a path parameter), or high risk; idempotent for PUT and DELETE; `openWorldHint` is false for all.
3. Two transports: stdio, and Streamable HTTP at `127.0.0.1:3333/mcp` with the SDK's localhost Host and Origin checks (against DNS rebinding). The HTTP endpoint has no caller authentication yet and must stay on localhost.
4. The server calls the host API as one service account from `.env`, so it has exactly that account's permissions.
5. The executor gained an optional cancellation signal; the MCP request signal is passed through, so a cancelled call also stops its HTTP request.
6. The server loads the repo's `.env` itself, so `.mcp.json` holds only a relative command and no secrets.

## Alternatives considered

### SDK v1 (`@modelcontextprotocol/sdk`)

- One package, more examples online.
- Rejected: v2 is the stable line for the current spec; starting on the legacy line means a migration later.

### Low-level `Server` with hand-written `tools/list` and `tools/call` handlers

- Full control, no double validation.
- Rejected: no argument validation, and exceptions become protocol errors. `McpServer` with `fromJsonSchema` gives validation and readable errors for free.

### Stateful HTTP sessions

- Allows server-initiated messages on a session.
- Not needed: our tools are request and response only. Stateless scales behind a load balancer without sticky sessions.

## Consequences

**Positive**

- `mcp:check` (official client) passes over both transports: 35 tools, schemas identical to the compiled ones, annotations as designed, all 19 read tools and a create/deactivate write pair succeed, and errors come back readable.
- Permissions travel end to end: as support, the 9 owner-only tools return a readable 403; as owner, they work.
- MCP Inspector (CLI mode, reading `.mcp.json`) lists and calls the tools.

**Negative**

- One shared service account: every MCP user acts with the same rights. Per-caller identity comes with Step 2.6 and Phase 4.
- The HTTP transport has no authentication.
- Arguments are validated twice (SDK AJV, then executor Zod); cheap, but redundant.
- The whole 35-tool menu is sent to the host; retrieval (Phase 3) does not apply to MCP hosts that list all tools.

**Follow-ups**

- 2.6: per-tenant servers and credentials; bearer auth in front of the HTTP handler.
- Phase 4: approvals for high-risk tools inside the server, not only in the host.

## References

- ADR 0015 (executor), ADR 0017 (cache).
- MCP TypeScript SDK v2 docs: servers/tools, serving/http, serving/stdio.
- Claude Code docs: MCP (`.mcp.json`, project server approval).
