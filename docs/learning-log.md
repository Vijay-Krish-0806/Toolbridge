# Learning log

One line per step: what I learned, in my own words where possible.

- 2026-11-15, Step 0.1: monorepo scaffold. Turborepo runs tasks in package-dependency order and skips work whose input hash is unchanged; strict TypeScript plus `noUncheckedIndexedAccess` makes missing values a compile error. Note: `toolbridge-step-0.1-monorepo-scaffold.md`.
- 2026-11-16, Step 0.2: host domain and deterministic seed. A seed is repeatable only if every source of change is pinned: random numbers (seeded generator), time (fixed reference date) and ids (built from fixed inputs). Money as integer cents; order items keep a price snapshot. Note: `toolbridge-step-0.2-deterministic-seed-data.md`.
- 2026-11-16, Step 0.3a: read API, JWT auth and roles. Authentication (401: who are you?) and authorization (403: are you allowed?) are separate guards; protect every route by default and opt out with @Public(). Writing the role rule and its Swagger text from one value keeps docs honest for agents. Note: `toolbridge-step-0.3a-api-auth-and-docs.md`.
