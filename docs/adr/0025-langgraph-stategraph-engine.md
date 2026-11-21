# ADR-0025: LangGraph StateGraph engine alongside the raw loop

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

Step 4.1. The agent so far is a hand-written ReAct loop (`packages/agent-core/src/agent/loop.ts`): a `for` loop that calls the model, runs tools and stops on an answer or a limit. Its control flow and run state live in local variables, so a run cannot be paused, saved or resumed. Later Phase 4 steps need exactly that: approvals that pause a run and resume it after a restart (4.3), and workers that pick up a dead worker's run (4.4).

Facts checked on 2026-11-21:

- `@langchain/langgraph` 1.7.5 (released 2026-11-17) needs `@langchain/core` ^1.3.4 and accepts zod ^4.2 as a peer (npm registry). `@langchain/core` 1.4.1 is pinned.
- The LangGraph.js docs (docs.langchain.com/oss/javascript/langgraph/graph-api, /use-graph-api, /streaming) define state with `StateSchema` and `ReducedValue`, runtime dependencies with a context schema passed as `config.context`, custom stream events with `config.writer`, and a default `recursionLimit` of 25 super-steps that throws `GraphRecursionError`. Plain `{ role, content }` objects are allowed as messages.
- `config.writer` is typed as optional in 1.7.5 and is absent when the graph runs without streaming (typecheck, not the docs).

## Decision

**Add a custom `StateGraph` engine (`agent/graph/`) with the same input and result as the raw loop, and build Phase 4 features on it.** The raw loop stays as the measured baseline and gets no new features.

- Nodes: `selectTools -> callModel -> (executeTools -> callModel)* -> finalize`, with two conditional edges whose routers only read `stopReason`.
- State: our own `ChatMessage` objects in an append reducer, usage in a sum reducer, plain counters. Only JSON-friendly data, ready for a checkpointer.
- Dependencies (LLM provider, registry, executor, selector, limits) go in the run context, never in state.
- Progress events use the `custom` stream mode (`config.writer`); the runner streams `["custom", "values"]` and keeps the last `values` chunk as the result.
- The shared steps (`agent/steps.ts`) are used by both engines, so only orchestration differs. `chat --engine loop|graph` picks one; the default is `graph`.

## Alternatives considered

- **Prebuilt `createAgent` (langchain package).** Not chosen: it expects LangChain chat models and tool classes, so it would bypass the `LLMProvider` port, the tool selector, the one-at-a-time rule for writes and the "not offered, refused" boundary from ADR 0022.
- **Keep only the raw loop and add pause/resume by hand.** Not chosen: it would mean writing state serialization, checkpoint storage and resume logic that LangGraph already provides and documents (needed in 4.3 and 4.4).
- **LangChain message classes and the `messages` stream mode.** Not chosen: they would replace our provider-neutral message types across the codebase; the custom stream mode gives the same live progress.

## Consequences

Measured with `pnpm --filter @toolbridge/agent-core engines:compare --save` (results in `docs/results/engines-compare.md`):

- **Same behavior.** The shared test suite (`src/agent/loop.test.ts`, 7 cases per engine: menu boundary, usage, all four stop reasons, event order) passes on both engines. On the local 4B model, 6 read-only questions picked the same tools on both engines with identical first-call input tokens; output tokens and seconds differ run to run (model variance, and the loop always ran first, including the cold first call).
- **Positive:** the control flow is explicit (named nodes and routers), the state is a single schema that a checkpointer can save, and later steps can use built-in interrupts, checkpointers and stream modes instead of hand-written ones.
- **Negative:** framework overhead of about 2.5 to 4 ms median per run (p95 13 to 24 ms over two runs of 300) against about 0.03 ms for the loop. That is small next to a model call (seconds), but not zero. Two new dependencies that release several times a week. More concepts to learn (super-steps, channels, reducers), and stack traces now pass through LangGraph internals.
- **Risk:** state fields typed with `z.custom` are not validated at run time; they rely on the adapter and registry that create them.
- **Follow-ups:** Step 4.3 adds a checkpointer to `compile()`; the MongoDB checkpointer question in the build plan is still open.
