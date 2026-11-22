# ADR-0042: Token budgets per run and an insert-only usage ledger

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

A run can make up to 8 model calls, each sending the whole conversation (up to a 16K context), so one run can use over 100K tokens. Until Step 4.6 nothing bounded a run's total tokens: only the per-call output cap (`LLM_MAX_OUTPUT_TOKENS`, Step 4.4a) and the leg time limit. On a paid model that is money; on the local model it is GPU time other tenants wait for. The build plan asks for token accounting per run and tenant, cost from a configurable price table (zero for local models), caps with a graceful stop, and a usage endpoint.

Two facts shape the design. BullMQ delivers a leg at least once (ADR 0034), so a retried leg calls the model again and really spends those tokens. And the run's totals in its checkpoint (`state.usage`) only include the calls of the attempts that were saved, so they can undercount spend.

This ADR covers session (a): the per-run cap, prices and usage rows. Session (b) adds the per-tenant monthly budget (429 when it is used up, calendar month in UTC) and the usage report.

## Decision

The graph's model node enforces `maxRunTokens` (from `RUN_MAX_TOKENS`, default 60,000) with one rule: never start a model call that cannot fit. Before a call it needs room for a prompt at least as big as the last one plus 256 output tokens, and it limits the call's `max_tokens` to what is left. After a reply that is not a finished answer, it stops if the follow-up call could not fit. The run then ends `completed` with stop reason `token_budget`, the last reply's text kept, and that reply's tools not run.

Every finished model call is written by the worker as one insert-only `usage_records` row (tenant, run, model, tokens, cost in whole micro-USD, the price used). Prices come from a JSON table (`config/llm-prices.json`, `LLM_PRICE_FILE`), and the API and worker refuse to start when the configured model has no price. `GET /usage/runs/:runId` (API key only) returns what a run spent.

## Alternatives considered

### Count tokens before every call (a tokenizer in the platform)

- Estimate each prompt exactly before sending it, so the cap is never passed.
- Not chosen: it needs the model's own tokenizer (it differs per model and provider), a new dependency, and still misses thinking tokens. Using the last real prompt size as a lower bound needs nothing new. The cost is a bounded overshoot (below).

### Run totals only (copy `state.usage` into the run record at the end)

- No new collection; the totals already exist.
- Not chosen: it misses the tokens of legs that were retried, and the run record is written only when a run completes, so failed and cancelled runs would be charged nothing.

### Fail the run at the cap, or let it finish the current tool turn

- Mark the run `failed`, or run the requested tools and then stop.
- Not chosen: hitting a budget is a planned limit, not an error, so the run completes with a clear reason. Running tools whose results no model call will read can perform a write that nobody reports back.

### Cost as a float in USD, or a price set by env variables

- Not chosen: floats round money badly when summed; a single env price cannot describe several models, and an unknown model would silently count as free.

## Consequences

**Positive**

- A run's tokens are bounded, across all its legs (the cap reads checkpointed totals).
- Spend is counted where it happens, retries included, and history keeps the price in force at the time.
- The same code costs a local model at 0 and a paid model at its price; an unpriced model cannot start.

**Negative**

- Soft cap: the prompt's size is known only after the call, so a run can pass its cap by the part of one prompt the estimate missed. The first call has no estimate: in a live run with `RUN_MAX_TOKENS=3000` the first prompt alone was 3,810 tokens, so the run used 3,920. With the 60,000 default this only matters for a cap smaller than one prompt.
- A run stopped after a tool-call reply ends with that reply's tool calls unanswered in its conversation. Nothing continues a finished run today; Step 4.7 (memory) must not replay such a conversation unchanged.
- Usage rows are written after each call and awaited at the end of the leg; a process that dies mid-leg can lose the rows of its last calls. A row that fails to save is logged, not retried.
- Only the LangGraph engine enforces the cap; the raw loop is a frozen baseline.
- Prices are an operator file, not per tenant, and the platform does not check them against provider price pages.

**Follow-ups**

- Session (b): `Tenant.monthlyTokenBudget`, `PUT /tenant/budget`, 429 `budget_exhausted` on `POST /runs`, the run cap = min(`RUN_MAX_TOKENS`, tenant tokens left), and `GET /usage?from=&to=` by day and model.

## References

- The adapter's `max_tokens` and `stream_options.include_usage` fields were adopted in Steps 1 and 4.4a; no new external API is used here.
- ADR 0034 (workers, at-least-once delivery), ADR 0032 (insert-only audit log), `docs/run-events.md` (stop reasons).
