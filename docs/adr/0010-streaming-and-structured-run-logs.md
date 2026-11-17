# ADR-0010: Stream every model turn and log runs as JSON lines through agent events

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

Model turns take 15 to 60 s locally, and most of that is the model's "thinking", which the adapter used to drop. Users saw nothing until the whole answer arrived. Debugging relied on `console.log` output that was gone once the terminal closed. Plan principle 6 requires every run to have an id that appears in its logs.

## Decision

- The agent loop always calls `llm.stream()`. It passes on text pieces (`text-delta`) and Ollama's non-standard `reasoning` field (`reasoning-delta`) as agent events. Reasoning is display-only: it is not stored in the conversation and is not sent back to the model.
- Logging uses Pino 10.4.0, writing JSON lines to `logs/agent.ndjson` (gitignored). Each run gets a `crypto.randomUUID()` runId, bound through `logger.child({ runId })`.
- Logging is attached through the existing `onEvent` callback and the executor's `onRetry` hook, not inside the loop. The loop stays free of I/O.
- Logs record tool arguments, durations, error codes and result *sizes*, but not tool result bodies. Streaming pieces are not logged; the final answer is logged once at `run-end`.
- The destination is synchronous (`sync: true`).

## Alternatives considered

### Keep `generate()` and show a spinner

- Simpler, with no stream handling.
- Rejected: the stream was already built and tested in Step 1.1. Showing the thinking also makes the agent's tool choices easy to inspect.

### Log from inside the loop with an injected logger

- Logging can't be forgotten.
- Rejected: it mixes I/O into the loop. Events already carry everything a logger needs, and the UI and SSE stream (later phases) consume the same events.

### `console.log` or a plain-text log file

- No dependency.
- Rejected: plain text can't be filtered by field (runId, level, tool), and Pino is the plan's chosen logger.

### Async Pino destination

- Faster under heavy load.
- Rejected for the CLI: the docs say buffered lines can be lost on exit, and a chat writes a few lines per minute. The API server (Phase 4) can revisit this.

## Consequences

**Positive**

- Users watch progress live, including the model's reasoning about which tool to call.
- Any run can be rebuilt from its JSON lines.

**Negative**

- `reasoning` is an Ollama-specific field. Other servers simply don't send it.
- Logs contain the user's question and the model's answer, which may include customer details. That's fine for local development, but needs redaction and retention rules before any shared deployment.
- Tool result bodies aren't logged, so reproducing a bad answer may need the host data at that time.

**Follow-ups**

- Step 1.4b: result shaping and truncation, and context-length measurements.
- Phase 5: send the same events to Langfuse traces.

## References

- https://github.com/pinojs/pino/blob/main/docs/api.md
- https://github.com/pinojs/pino/blob/main/docs/asynchronous.md
- ADR-0007, ADR-0009
