# ADR-0040: Idempotency keys, and a retry policy by tool class

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Since Step 4.4a, runs execute on workers with at-least-once delivery: a worker that dies is replaced, and LangGraph re-runs the node that was in progress. ADR 0034 made that safe by refusing to repeat a write that had already started (`outcome_unknown`). Safe, but a person must then check by hand whether the refund happened. Step 4.5 asks for exactly-once effects: idempotency keys on write tools with stored results, a retry policy by tool class, and a retry after a token refresh or a change of identity that reuses the same key. Done check: kill a worker between a side effect and its acknowledgement, and no duplicate refund occurs.

Only the API that performs the write can make it happen once; the client can only send the same key every time. So the host API, which we own, takes part.

## Decision

**Writes carry an idempotency key derived from durable state; APIs that support keys store results by key; only keyed writes are ever retried, or resent after a takeover.**

- **Host API** (`IdempotencyInterceptor`, global): a write with `Idempotency-Key` first reserves the key (atomic unique insert, `in_progress`), runs the route, and stores the status and body before answering. A repeat with the same request gets the stored answer (`Idempotent-Replayed: true`); a repeat while the first is still running gets 409 with `Retry-After`; the same key for a different request gets 422. 4xx answers are stored, 5xx are not (so a retry may succeed). Keys are per user, kept 24 hours (TTL by the real clock, not the demo's frozen one). Requests without the header behave as before.
- **The key:** `sha256(tenant, run id, call id, arguments hash)`. It holds no credential or time, so a retried attempt, a refreshed token, a different identity (delegation) or a worker takeover all send the same key. Direct tool calls use a key per request.
- **Which APIs:** `idempotencyHeader` on the spec's connection (for example `Idempotency-Key`; null by default). Not a spec parameter: a header declared in the spec would become an argument the model could set.
- **agent-core:** `ToolExecutor` gets `idempotencyKeyFor(call)` for writes; the key goes into `ToolContext.idempotencyKey`, and generated tools send it as the configured header.
- **Retry policy by tool class:** reads retry on retryable errors (as before); a write retries only with a key; a write without a key is never retried. A 409 counts as retryable only with `Retry-After`, so business conflicts ("only 100 cents left") are not retried.
- **After a takeover:** a write that already started is sent again when it has a key (the API replays the stored answer, and the run gets the real result); without a key it stays `outcome_unknown` (ADR 0034).

## Alternatives considered

- **A random key per attempt.** Not chosen: it deduplicates nothing; the mutation test (a key that changes per attempt) files two refunds.
- **Keep `outcome_unknown` as the only answer.** Safe, but every crash during a write needs a person. Keys keep that as the fallback for APIs without support.
- **Look the refund up before retrying** ("did order X get a refund for N cents?"). Not chosen: it needs a per-tool notion of "the same write", is racy, and two identical legitimate refunds would look like one.
- **Store results in ToolBridge instead of the API.** Not enough: a crash between the API doing the write and ToolBridge storing the result is exactly the gap; only the side that performs the write can close it.
- **Declare the header in the host's OpenAPI spec.** Not chosen: the compiler would expose it to the model as an argument.

## Consequences

- **Positive (tests):** host e2e: the same key twice is one refund with the same answer, ten parallel requests with one key are one refund, a reused key for another request is 422, keys are per user, a refusal is replayed as the same refusal. Worker e2e with real processes killed by SIGKILL between the refund and its answer: one refund, the same key sent twice, the run completes with the host's real answer, audit `ok`; without the key setting the same crash ends `outcome_unknown` with one refund. Unit: a keyed write retries with the same key; an unkeyed write never retries; a keyed write that already started is sent again. Removing the host's atomic reservation, or making the key change per attempt, makes a test fail.
- **Negative:** exactly-once holds only for APIs that implement keys (others keep `outcome_unknown`); host storage of answers for 24 hours (one small document per write); a retry within 24 hours with the same key but a changed body is refused rather than performed.
- **Follow-ups:** session (b): circuit breaker and per-tenant rate limiting (ADR 0041).
