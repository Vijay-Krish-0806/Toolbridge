# ADR-0001: Monorepo with pnpm workspaces and Turborepo

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

ToolBridge will have four apps (host store API, platform API, worker, web UI) and six packages (shared, spec-compiler, mcp-server, agent-core, retrieval, policy), plus evals. Types such as the compiled tool model and the policy decisions are shared between the compiler, the API, the worker and the UI. The core packages (`spec-compiler`, `policy`) must stay free of network and database code (plan section 3, principle 2). One developer maintains it, and CI must run lint, typecheck and test on every push.

## Decision

The system uses one git repository with pnpm workspaces (`apps/*`, `packages/*`) and Turborepo as the task runner. Packages depend on each other through `workspace:*`. Turborepo runs `build`, `typecheck`, `lint` and `test` in dependency order (`dependsOn: ["^build"]`) and caches each task's result by a hash of its inputs.

Pinned versions: pnpm 12.21.0 (`packageManager` field), Turborepo 2.11.11, Node 24.

## Alternatives considered

### Polyrepo (one repository per app or package)

- Shared packages would be published to a registry and versioned.
- Not chosen: a change to the tool model would need a publish and an upgrade in every consumer. That is heavy for one developer, and a cross-cutting change could not land in one commit.

### Nx

- A monorepo build system with its own project graph, generators, caching and plugins.
- Not chosen: it does more than we need and brings its own conventions and plugins to learn. Turborepo sits on top of plain pnpm workspaces, so removing it later means deleting one file and changing four scripts.

### Plain pnpm workspaces without a task runner

- `pnpm -r run build` runs scripts in topological order.
- Not chosen: it has no caching, so CI and local runs would redo unchanged work as packages are added. Turborepo adds caching for one dev dependency and a short `turbo.json`.

## Consequences

**Positive**

- Package boundaries are visible in each `package.json`, so a forbidden dependency (for example `policy` importing a database driver) shows up in review.
- Unchanged packages are not rebuilt or retested; Turborepo replays cached logs and outputs.
- One commit can change a shared type and all of its consumers.

**Negative**

- More configuration files at the root (workspace, Turborepo, base tsconfig, lint).
- A package boundary does not stop importing a library that is installed elsewhere in the repo; a lint rule will be needed when the pure packages exist.
- Turborepo's cache is only correct if task inputs and outputs are declared correctly. A wrong `outputs` entry gives stale or missing build files.
- Corepack 0.34 could not run pnpm 12 on the developer machine (it looks for `bin/pnpm.cjs`, which pnpm 12 does not ship). pnpm is installed globally with npm instead, and CI uses `pnpm/action-setup`, which reads the pinned version.

**Follow-ups**

- Add a dependency rule for the pure packages (`spec-compiler`, `policy`) when they are created (Phase 2 and Step 4.2).
- Consider remote caching for CI only if CI time becomes a problem.

## References

- docs/BUILD_PLAN.md sections 2 and 3.
- https://pnpm.io/workspaces
- https://turborepo.dev/docs/reference/configuration
