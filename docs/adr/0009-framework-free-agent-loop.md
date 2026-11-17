# ADR-0009: Framework-free agent loop with explicit stop conditions

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

Step 1.3 connects the LLM port (ADR-0007) and the tool executor (ADR-0008) into an agent that answers multi-step questions. The plan builds this loop by hand before adopting LangGraph in Phase 4, so the team understands what a framework would replace. Local constraints shape the design. There is no `tool_choice`, so the model may answer in text at any step. Each model call takes about 6 to 60 s. Small models may repeat bad calls, and they may emit one or several tool calls per turn.

## Decision

`runAgent` is a plain loop: call the model, run its tool calls, append each result as a `tool` message, and repeat. It stops for one of four reasons:

- `answer`: a text reply with no tool calls
- `max_iterations`: default 8 model calls
- `too_many_errors`: 3 failed tool results in a row
- `length`: the model hit its output limit

Tool calls from one turn run in parallel when all are reads, and in order, one at a time, when any is a write. Usage (input and output tokens, call counts, latest prompt size) is added up per run. Progress is reported through an `onEvent` callback, so the loop has no I/O of its own.

## Alternatives considered

### LangGraph.js now

- Gives checkpointing, interrupts and streaming for free.
- Rejected for now: the plan adopts it in Phase 4. Building the loop first makes its value (durable state, human approval interrupts) concrete.

### Always run tool calls one at a time

- Simplest, with no concurrency questions.
- Rejected: independent reads (for example, get a customer and list their orders) would wait on each other for no reason.

### Always run tool calls in parallel

- Fastest.
- Rejected: a write running alongside other calls makes ordering and auditing harder. Writes are rare, so running them in order costs little.

## Consequences

**Positive**

- The loop is about 80 lines with no dependencies, and it can be tested with the FakeProvider.
- The CLI, and later the API and UI, attach through events, not through changes to the loop.

**Negative**

- No persistence: if the process dies mid-run, the run is lost. Phase 4 (durable runs) addresses this.
- No streaming of tokens yet. That's Step 1.4.
- The whole conversation is resent on every call. Long chats approach the context limit, so the CLI warns at 80%.

**Follow-ups**

- Step 1.4: stream tokens and tool events, add structured logs keyed by run id, and shape oversized results.

## References

- ADR-0007, ADR-0008
- BUILD_PLAN.md Step 1.3
