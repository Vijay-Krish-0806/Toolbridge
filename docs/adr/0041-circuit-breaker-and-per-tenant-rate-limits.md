# ADR-0041: Circuit breaker and per-tenant rate limits

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.5's second half: a circuit breaker and a Redis token-bucket rate limiter per tenant. Without them, a host API that is down makes every run wait for timeouts and retries, which adds load exactly when the API can least take it; and one busy tenant can start runs and tool calls fast enough to overload its own API or the shared workers. Session (a) (ADR 0040) made writes safe to retry; this session decides when not to call at all.

## Decision

**A circuit breaker per API in each worker, and token buckets per tenant in Redis for run starts and for tool calls. Both stop a call before anything is recorded or sent.**

- **Breaker (`CircuitBreaker`, agent-core):** closed until 5 failures in a row, then open for 30 s (calls fail at once with `circuit_open`, nothing sent), then half-open: exactly one probe call goes out; its success closes the circuit, its failure opens it again. Failures are network errors, timeouts and retryable HTTP errors (5xx, 429); a 4xx is the API answering, so it counts as healthy. The executor checks it before every attempt, so retries stop as soon as it opens.
- **Scope of the breaker:** one per tenant and spec (one API), in memory in each worker process (`Breakers`). Each worker learns on its own that an API is failing, which is enough to stop hammering it.
- **Token bucket (`RateLimiter`):** one Lua script run atomically by Redis (no two processes can take the last token), using Redis's own clock (processes with different clocks agree). Keys per tenant and per limit, with an expiry, under the queue prefix.
- **Limits:** `RATE_RUNS_PER_MINUTE` (default 30, burst 30): `POST /runs` over the limit gets 429 with `Retry-After` in seconds and nothing is saved or queued. `RATE_TOOL_CALLS_PER_SECOND` (default 10, burst 20) across all of a tenant's runs: the executor waits out a short wait (up to 2 s, three times), so a busy run slows down instead of failing; a longer wait refuses the call with `rate_limited`.
- **Order in the executor:** access check, arguments, breaker, rate, credential, write-ahead row, send. A call stopped by the breaker or the rate leaves no audit row and reaches no API.

## Alternatives considered

- **A shared breaker in Redis.** All workers would learn together. Not chosen now: an extra round trip on every call, and the per-worker breaker already stops the flood within a few failures per worker.
- **Fixed-window counters** (`INCR` per minute). Simpler. Not chosen: a burst at the window edge doubles the real rate; a token bucket smooths it and gives a natural Retry-After.
- **Rate limiting in a gateway (nginx, API gateway).** Fine for `POST /runs`, but it cannot see tool calls, which happen inside workers.
- **Fail tool calls at once when rate-limited.** Simpler. Not chosen: a turn often makes several calls together, and waiting a few hundred milliseconds is better for the user than an error the model must handle.

## Consequences

- **Positive (tests):** unit: the breaker opens after the threshold, a success resets the count, the cool-down allows exactly one probe, its success closes and its failure reopens; the executor fails fast while open without calling the tool, a 4xx does not count, a short rate wait is waited out and a long one refuses without calling. e2e on real Redis: a tenant over its run limit gets 429 with a Retry-After that matches the refill rate, another tenant is unaffected, and the bucket refills with time. A bucket key without the tenant makes a test fail.
- **Negative:** each worker's breaker is separate (a failing API gets a few calls from each worker before every breaker opens); limits are per tenant only (not per user or per spec); a refused run is the caller's to retry.
- **Follow-ups:** Step 4.6 (budgets) adds token caps per run and tenant; U4 can show breaker and limit events in the run trace.
