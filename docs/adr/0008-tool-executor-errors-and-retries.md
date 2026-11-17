# ADR-0008: Tool executor returns errors as results and never retries writes

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

Step 1.2 adds tools that call the host store API, and an executor that runs the tool calls the model asks for. Small local models often send wrong tool names, invalid JSON or arguments that fail validation. Network calls can time out or hit a server error. Some tools write data: `request_refund` creates a refund, and the host API has no idempotency keys yet (Step 4.5). If a write times out, we cannot tell whether the server already did it.

## Decision

1. `ToolExecutor.run` never throws. Every outcome is a `ToolResult`: `{ ok: true, content }` or `{ ok: false, error: { code, message, retryable, status? } }`. Errors go back to the model as tool results, so it can correct itself.
2. Each attempt has a timeout, enforced with an AbortSignal passed to `fetch` and a race. That way a tool that ignores the signal still cannot hang the run.
3. Retries happen only for retryable errors (timeout, network, 429, 5xx), only for `read` tools, at most 2 extra attempts, with exponential backoff and jitter.
4. `write` tools are never retried automatically.
5. Tool input schemas are Zod. Zod 4's built-in `z.toJSONSchema` produces the schema the model sees, so the `zod-to-json-schema` package from the plan is not needed.

## Alternatives considered

### Throw errors to the agent loop

- Simpler executor.
- Rejected: the loop would end the run on any mistake. Sending the error to the model as a result lets it fix bad arguments, which matters most with small models.

### Retry every failure, including writes

- Better success rate when the network is flaky.
- Rejected: a timeout after the server committed the refund would refund twice. Safe write retries need idempotency keys (Step 4.5).

### Let the model decide on retries alone

- No retry code in the executor.
- Rejected: each model turn costs about 9 s locally. A short backoff retry for a transient 503 is cheaper, and it doesn't fill the context.

## Consequences

**Positive**

- The loop in Step 1.3 can treat every tool call the same way: append the result and continue.
- Money-moving tools cannot be duplicated by our own retries.

**Negative**

- A write that fails on a transient error is not retried. The model (or a person) must decide.
- Retrying a read up to 3 times can add a few seconds to a slow failure.

**Follow-ups**

- Step 4.5: idempotency keys, after which write retries can be reconsidered.
- Phase 2: generated tools reuse this executor unchanged.

## References

- BUILD_PLAN.md Step 1.2 and principle 5 ("Writes are special")
- ADR-0007 (LLM port)
