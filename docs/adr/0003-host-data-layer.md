# ADR-0003: Host store data layer with Mongoose and a deterministic seed

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

`apps/host-store-api` is the sample online store that ToolBridge will compile into agent tools. It should look like a typical existing NestJS and MongoDB application, because that is what ToolBridge meets in practice. Evals and later checks need the store's data to be identical after every reset (`pnpm seed`), so results are comparable between runs. The seed must also contain edge cases on purpose: delayed shipments, large refunds, expired coupons, and notes containing prompt-injection text.

## Decision

The host store defines its data with Mongoose 9.12.1, using explicit TypeScript interfaces and plain `new Schema<T>({...})` definitions, one per entity. The seed is a pure function from a numeric seed to a dataset, built with a seeded pseudo-random generator, a fixed reference date (`2026-11-01T00:00:00Z`) instead of the current time, and deterministic ObjectIds (creation time, entity code, counter).

## Alternatives considered

### Native `mongodb` driver with Zod schemas

- One schema language across the whole repository.
- Not chosen: unusual in NestJS applications, so the host app would be less representative of what ToolBridge consumes, and it needs more hand-written validation and index code.

### Mongoose `@Prop()` decorators through `@nestjs/mongoose`

- The NestJS documentation's default style.
- Not chosen: plain schemas keep the data model independent of NestJS, so the seed script runs without starting the app, and both styles register the same way through `@nestjs/mongoose` (`MongooseModule.forFeature`). The API's Swagger documentation comes from DTO classes, not from these schemas, so the choice does not affect the OpenAPI spec.

### Faker for seed data

- Realistic names and addresses with little code.
- Not chosen: a seeded generator plus short word lists already meets the need, and avoids a dependency whose generated output can change between versions.

## Consequences

**Positive**

- `pnpm seed` produces the same database every time. MongoDB's `dbHash` command gives identical per-collection hashes across runs.
- Schema validation runs on insert, so a generator bug fails at seed time, not later in the API.
- Money is stored as integer cents and line items keep a price snapshot, matching common practice for orders.

**Negative**

- Each entity has both an interface and a schema, which must be kept in step by hand.
- The seeded world is frozen at the reference date. Any API logic that uses "now" (for example, delayed orders) must read time from an injectable clock, not `Date.now()`.
- The word lists produce less varied text than Faker.

**Follow-ups**

- Step 0.3: add an injectable clock set to the reference date for the API.
- CI's `infra` job runs `pnpm seed` against real MongoDB as a smoke check.

## References

- Mongoose TypeScript schemas: https://mongoosejs.com/docs/typescript/schemas.html
- Migrating to Mongoose 9 (Node 20.19+ required): https://mongoosejs.com/docs/migrating_to_9.html
- BUILD_PLAN.md, Step 0.2
