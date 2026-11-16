# ADR-0006: Committed OpenAPI spec, and e2e tests run against the tsc-compiled app

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

ToolBridge (Phase 2) compiles agent tools from the host store's OpenAPI spec, so the spec must be a stable, reviewable file that always matches the code. The host app's auth and refund rules are security and money logic and need automated end-to-end tests.

NestJS relies on TypeScript decorator metadata (`emitDecoratorMetadata`). A probe on 2026-11-16 showed that Vitest 5.1 (on Vite 8) cannot compile a decorated NestJS class at all: it fails with "SyntaxError: Invalid or unexpected token". The repository builds with plain `tsc`, which does emit the metadata.

## Decision

`pnpm export:spec` builds the app without connecting to MongoDB (`lazyConnection`) or starting a server, and writes `specs/host-store.json`. The file is committed, excluded from Prettier, and CI fails if a fresh export differs from it (`git diff --exit-code specs/`).

E2E tests use Vitest and Supertest 7.3.2. `pnpm test:e2e` first compiles the app with `tsc`; the tests import decorated classes from `dist/` and take types from `src/`. Each test file seeds a separate `host_store_e2e` database in the Docker MongoDB.

## Alternatives considered

### Compile tests with SWC (`unplugin-swc` and `@swc/core`)

- Lets Vitest compile decorated source directly, so tests import from `src/`.
- Not chosen: two extra dependencies, and a second compiler whose output can differ from the `tsc` build that runs in production.

### Fetch the spec from a running server

- Simple: `curl /docs/json` into a file.
- Not chosen: needs MongoDB and a started server, so the CI check would become slow and fragile.

### Testcontainers for the e2e database

- A fresh MongoDB container per test run.
- Not chosen: the Docker Compose MongoDB already runs locally and in CI; a separate database name gives the needed isolation without another dependency.

### `fetch` against a listening server instead of Supertest

- No dependency.
- Not chosen: Supertest is the NestJS convention, calls the app in-process without a port, and its assertions read clearly.

## Consequences

**Positive**

- The spec ToolBridge consumes is versioned in git; API changes show up as reviewable diffs.
- Tests run the same compiled code as production. Twelve tests cover login, forged and expired tokens, 403s, the refund lifecycle and a concurrent double-refund (stable across three runs).
- Development data is never touched by tests.

**Negative**

- `pnpm test:e2e` must build first (a few seconds), and editing a test does not pick up source changes until the next build.
- Tests mix two import roots (`dist/` for decorated classes, `src/` for plain modules); a reader must know why.
- E2E test files share one database, so they run one at a time.

**Follow-ups**

- Revisit if Vitest gains support for legacy decorator metadata; tests could then import from `src/` only.

## References

- NestJS OpenAPI introduction: https://docs.nestjs.com/openapi/introduction
- BUILD_PLAN.md, Step 0.4; ADR-0005 (refund rules under test)
