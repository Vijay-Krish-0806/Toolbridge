# ADR-0013: Spec loader with external refs disabled, and an ApiModel intermediate representation

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

Step 2.1 starts `packages/spec-compiler`. It must load OpenAPI 3.x from a file or URL, dereference `$ref`s, and give later stages (tool generator 2.2, HTTP executor 2.3, cache 2.4, MCP server 2.5) one predictable shape.

Facts found while building:

- `@apidevtools/swagger-parser` 13.1.0 (the plan's choice) accepts OpenAPI 3.0.0–3.0.4 and 3.1.0–3.1.2, plus Swagger 2.0 (read from its shipped source; its online docs pages returned 404).
- **Local File Inclusion is real.** With default options, a spec containing `$ref: "./secret.json"` made the parser read that file from disk and inline it. A spec uploaded by a tenant could pull in a `.env`.
- `resolve.external: false` leaves such refs untouched and reads nothing (checked by experiment and kept as a test).
- The HTTP resolver (json-schema-ref-parser 16.0.8) has `safeUrlResolver`, on by default. A local server serving the host spec on 127.0.0.1 received **0 requests**: loopback URLs are refused before connecting.
- `dereference.circular: 'ignore'` keeps every `$ref` that takes part in a cycle, including the first one, so an operation's schema can be just `{ $ref }`.
- Real specs: host 41 ops (2 cyclic form schemas); GitHub 1,281 ops (14 MB, no security schemes declared, 16.5 s to load); Stripe 612 ops (8 MB, 218 cyclic schemas, every body form-urlencoded, 273 GETs with a request body).
- Plan principle 2 says spec-compiler is a pure core with no network access, but Step 2.1 asks it to load from URLs.

## Decision

1. All I/O lives in one adapter, `load.ts` (`loadSpec`). It validates and dereferences with `resolve.external: false` and `circular: 'ignore'`, keeps the HTTP resolver's safe defaults with a 15 s timeout, and rejects Swagger 2.0.
2. `normalize.ts` is a pure function from the document to an `ApiModel` IR: `Operation`s with merged parameters (operation wins on `(in, name)`), one chosen content type (JSON preferred), flattened responses, and effective security (operation's own, else the document default).
3. Cycle targets are stored once in `ApiModel.schemas`, keyed by ref string, so the IR stays plain JSON and loses nothing.
4. Anything unusable becomes a `CompileWarning`, not an exception.

## Alternatives considered

### Raw OpenAPI everywhere (no IR)

- Each later stage reads the spec itself.
- Rejected: parameter merging, security inheritance, content-type choice and 3.0/3.1 differences would be re-implemented in 2.2, 2.3 and 2.5.

### Fully dereferenced objects with cycles (`circular: true`)

- Simplest to walk in code.
- Rejected: real JS cycles break `JSON.stringify`, so no snapshots and no hash for the 2.4 cache.

### `bundle()` (keep every internal `$ref`)

- Small and serializable.
- Rejected: every consumer would have to resolve refs itself; most refs (all of the host's but two) can safely be inlined.

### `@scalar/openapi-parser` or `@readme/openapi-parser`

- Active alternatives (0.29.25 and 10.0.0).
- Not chosen: the plan names swagger-parser, it is maintained (13.1.0, Sept 2026), and it covers 3.0 and 3.1. Revisit only if it blocks us.

## Consequences

**Positive**

- `normalize` is pure and fast (2 ms host, 299 ms GitHub), so the API (2.6) and cache (2.4) can call it on specs they already hold.
- Uploaded specs cannot read local files, and loopback URLs are refused.
- A file snapshot of the host IR turns any compiler change into a reviewable diff.

**Negative**

- Specs split across several files do not load; their external refs stay as `$ref` with a warning. Users must bundle first.
- A local API's spec cannot be loaded by URL (for example `http://localhost:3000/docs-json`); load the exported file instead.
- SSRF protection here is only the library's; DNS rebinding and redirects to private hosts were not tested.

**Follow-ups**

- 2.2: treat a leftover `$ref` as a recursive object (look it up in `schemas`, with a depth limit); decide what to do with non-JSON bodies and GETs with bodies.
- 2.2: a spec's missing security does not mean public (GitHub declares none). Allow an override.
- 2.3: our own SSRF-safe client for tool calls; do not rely on the parser's.

## References

- `@apidevtools/swagger-parser` SECURITY.md (Local File Inclusion).
- Build plan section 3 (principle 2, pure core) and Step 2.1.
