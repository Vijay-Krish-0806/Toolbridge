# ADR-0017: Content-addressed compile cache and a breaking-change diff on the IR

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Step 2.4: unchanged specs should skip recompilation, and a new spec version should be compared with the old one, flagging changes that would break existing tool calls. Measured on GitHub's 14 MB spec (local file):

| Stage                                | Time           |
| ------------------------------------ | -------------- |
| read + parse (`SwaggerParser.parse`) | 109 ms         |
| canonical sha256 of the parsed spec  | 113 ms         |
| validate + dereference               | about 1,300 ms |
| normalize + compile tools            | about 60 ms    |

Validation is about 90% of the cost, so a cache must decide hit or miss before validating. A canonical hash (sorted keys) gave the same value for a reformatted, key-reordered copy (14.3 MB vs 20.3 MB on disk). Existing diff libraries: `openapi-diff` (Atlassian) 0.24.1, last updated August 2025; the npm name `oasdiff` is a "0.0.1-security" placeholder (the real oasdiff is a Go tool).

## Decision

1. Loading is split into `parseSpec` (cheap) and `validateSpec` (expensive); `loadSpec` still does both.
2. `compileSpec` keys the cache on `sha256(COMPILER_VERSION + specHash + overridesHash)`, where each hash is sha256 of canonical JSON. `specHash` alone is the spec's version id.
3. `COMPILER_VERSION` is a constant bumped by hand whenever compiler output changes for the same input. The golden snapshot diffs are the reminder.
4. The cache is a port, `CompileCache`, with `MemoryCache` and `FileCache` (`.cache/specs/<key>.json`, git-ignored, written via temp file + atomic rename; a corrupt or mismatched file is a miss). A database adapter comes with the platform API (2.6).
5. `diffModels(before, after)` compares two ApiModels. Operations are matched by method + path with parameter names blanked (`GET /orders/{}`). Rules: breaking = removed operation, changed operationId (tool name), new required parameter or field, removed parameter or field, optional to required, type change, enum value removed on the request side, response field removed, auth newly required or changed. Not breaking: additions of optional things, required to optional, response enum additions, deprecation, auth removed.
6. The `diff` script exits 1 with `--fail-on-breaking`, for CI.

## Alternatives considered

### Hash the raw file bytes

- Simplest and fastest (31 ms for 14 MB).
- Rejected: reformatting or reordering keys would count as a change. Parsing first costs about 0.1 s and is needed anyway.

### Derive the compiler version automatically (hash of the compiler's code or output)

- Cannot be forgotten.
- Not now: hashing source files at runtime is fragile in a built package, and hashing output means compiling, which defeats the cache. A manual constant plus snapshot diffs is simple; the risk is a forgotten bump, which only serves stale tools until the next bump.

### `openapi-diff` (Atlassian)

- A ready-made diff on raw specs.
- Not chosen: last updated 15 months ago, works on raw specs rather than our IR, and its notion of "breaking" is about clients in general, not generated tool calls (for example, an operationId change renames our tool).

### Cache only in memory

- No files to manage.
- Rejected for local runs: every CLI run is a new process, so it would never hit.

## Consequences

**Positive**

- GitHub spec: 1,492 ms miss, about 310 ms hit; host spec: 216 ms miss, 27 to 68 ms hit.
- Reformatting does not invalidate; editing overrides does (same spec hash, new key).
- The real host history (Step 2.1 spec vs today) is reported as 24 changed operations, all breaking type fixes, exit code 1. 13 rule tests pin the diff.

**Negative**

- A URL source is still downloaded on every call; only validation and compile are skipped. Conditional GET (ETag / If-None-Match) would skip the download too.
- Forgetting to bump `COMPILER_VERSION` serves old tools.
- The file cache never evicts entries.
- Schemas are compared up to 6 levels deep; `allOf`/`oneOf` changes are not analysed beyond single-item wrappers.
- "Breaking" is about the contract, not intent: Step 2.2's bug fixes are all flagged as breaking. A human or policy decides.

**Follow-ups**

- 2.6: database cache adapter, spec versions per tenant, and diffs on upload.
- Conditional GET for spec URLs; cache eviction when storage matters.

## References

- ADR 0013 (loader and IR), ADR 0014 (tool generation and overrides).
