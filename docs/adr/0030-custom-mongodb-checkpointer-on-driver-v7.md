# ADR-0030: Custom MongoDB checkpointer on driver v7

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.3 pauses agent runs for approval and resumes them later, possibly after a restart. LangGraph does this with a checkpointer: a `BaseCheckpointSaver` that stores the graph state after every super-step. Interrupts require one (LangGraph.js interrupts docs). The repo uses MongoDB with driver `mongodb` 7.8.0 everywhere. The build plan required a time-boxed spike with the official MongoDB checkpointer before choosing.

Spike, measured on 2026-11-22 in a scratch project:

- `@langchain/langgraph-checkpoint-mongodb` 1.5.2 lists `mongodb ^6.21.0` as a regular dependency (not a peer). Installing it next to 7.8.0 gave two drivers: `mongodb@6.22.0` nested under the saver, plus `mongodb@7.8.0`.
- Passing a v7 `MongoClient` to its constructor fails to compile: `TS2322 ... Types of property 'options' are incompatible`.
- The official conformance suite `@langchain/langgraph-checkpoint-validation` 1.2.1 depends on `vitest ^4`; under our vitest 5.1.0 it fails to start (`beforeAll is not defined`) unless vitest globals are on. With globals on, LangGraph's own `MemorySaver` passed 719 of 720 tests. The one failure, "should only store channel_values that have changed (based on newVersions)", is an optional storage optimisation that the reference saver does not do either.
- bson 7.3.4 (driver 7.8.0) changed `Binary.value()` to take no argument and return a `Uint8Array`; the official saver calls `value("utf8")` (bson 6).

## Decision

**Write a small saver, `MongoSaver`, in a new package `packages/checkpoint-mongo`, on driver 7.8.0, and validate it with the official conformance suite.**

- Same data layout as the official saver (two collections, `checkpoints` and `checkpoint_writes`, upserts keyed by thread, namespace and checkpoint id; pending writes ordered with LangGraph's exported `writesSortKey` and `WRITES_IDX_MAP`), so the behaviour matches what LangGraph expects.
- Values are serialized with LangGraph's own `serde` (`dumpsTyped` / `loadsTyped`); MongoDB stores the bytes.
- Full checkpoints are stored on every step, like `MemorySaver`. The one optimisation test is excluded by name, with this ADR as the reason.
- Checkpoints in LangGraph's older format (version below 4) are migrated on read: their "pending sends" are copied from the parent checkpoint's writes into the `__pregel_tasks` channel, as `MemorySaver` does. The first suite run against MongoDB failed 3 "should migrate pending sends" cases without this; the official MongoDB saver code read in the spike has no such step. Result after the fix (2026-11-22, Atlas Local): 719 conformance cases pass, 1 excluded.
- A separate package keeps agent-core free of any database driver (ports and adapters), and lets the Step 4.4a worker reuse it.

## Alternatives considered

- **Official saver with two drivers.** Not chosen: two connection pools per process, a type error at the boundary that would need a cast, and two driver versions to patch.
- **Pin the repo to driver v6.** Not chosen: a downgrade of every package for one dependency.
- **Checkpoints in Redis or Postgres.** Not chosen: a second database for one feature; Redis is planned only for queues and rate limits.
- **Hand-written tests instead of the conformance suite.** Not chosen: 719 official cases cover far more than we would write; the cost is a nested `vitest@4` dev dependency and `globals: true` in that package's test config.

## Consequences

- **Positive:** one driver; conformance checked by LangGraph's own suite; full control of indexes and, later, expiry (v3 list: checkpoint TTL).
- **Negative:** we own the code and must re-run the suite when `@langchain/langgraph-checkpoint` changes; full checkpoints grow with the conversation (each step stores the whole message list); the excluded test is a known gap.
- **Follow-ups:** tenant isolation is by run id (thread id = run id, a UUID); only code that has already checked the run's tenant may read a thread.
