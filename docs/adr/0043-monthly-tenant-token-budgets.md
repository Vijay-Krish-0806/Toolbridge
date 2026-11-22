# ADR-0043: Monthly token budgets per tenant

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

ADR 0042 caps each run and records every model call in the usage ledger, but a tenant can still start any number of runs. The build plan asks for token accounting per tenant, a cap with a graceful stop, and a usage endpoint. The owner chose a calendar month in UTC as the period and HTTP 429 as the refusal (2026-11-22).

Forces: the check sits on `POST /runs`, which the browser calls, so it must be cheap and must not reveal cost to end users. Several runs of one tenant can run at the same time, and their spend is only known after each model call. The ledger lives in a shared (pool model) collection, so every new query must stay inside the tenant.

## Decision

`Tenant.monthlyTokenBudget` (null = no limit, set with `PUT /tenant/budget`) is checked when a run starts: the tenant's tokens this UTC month are summed from the ledger, a run is refused with 429 `budget_exhausted` (no Retry-After) when fewer than 256 tokens are left, and otherwise the run's cap is fixed once as min(`RUN_MAX_TOKENS`, tokens left) and stored as `Run.tokenCap`. `GET /usage?from=&to=` (API key only, at most 366 days) reports use and cost by UTC day and model, with totals and the month's budget status. Ledger sums run in MongoDB through a new `TenantScoped.aggregate`, which always puts the tenant `$match` first and refuses `$lookup`, `$unionWith`, `$graphLookup`, `$out` and `$merge`.

## Alternatives considered

### Reserve tokens before each model call (a hard limit)

- Take tokens from a per-tenant counter before every call and give back what was not used.
- Not chosen: it needs a reservation on every call, a refund path for calls that fail or die, and still needs an estimate of the prompt size (ADR 0042). A soft limit, with each run bounded by its own cap, keeps the overshoot bounded without that machinery.

### Recompute the run's cap on every leg

- Each leg reads the tenant's balance again.
- Not chosen: the run's own spend lowers the tenant's balance as it goes, and the cap also counts that spend from the checkpoint, so the run would be charged twice and stop early.

### A running counter per tenant and month instead of an aggregation

- `$inc` a `(tenant, month)` document next to each usage row; the check reads one document.
- Not chosen for now: two writes that can disagree when one fails, for a speed-up not needed at this scale. The aggregation reads the `(tenantId, at)` index. It is the first follow-up if `POST /runs` gets slow.

### 402 Payment Required, or a rolling 30-day window

- Not chosen (the owner's choice): 402 has no agreed meaning in HTTP clients and suggests billing; a calendar month matches how bills and budgets are read.

## Consequences

**Positive**

- A tenant cannot start runs past its budget, and one tenant's budget never affects another.
- The cap is fixed per run, so a budget change applies to new runs only and never shortens a running one.
- Cost stays operator data: the usage endpoints refuse session tokens (401), so it never reaches a browser.

**Negative**

- Soft limit: runs that start together can each get a cap from the same balance, so a tenant can pass its budget by up to its running runs' caps. Measured only as a rule, not under load.
- Every `POST /runs` with a budget runs one aggregation over the month's rows; its cost grows with the tenant's calls this month (not measured).
- The month is UTC for every tenant; a tenant in another time zone sees its month change at a different local hour.
- 429 is also the rate-limit code: clients must read `error` (`budget_exhausted` has no Retry-After) to tell a quota from a burst limit.

**Follow-ups**

- A per-month counter if the aggregation shows up in `POST /runs` latency.
- Budget alerts (for example at 80%) are not built; the report shows `leftTokens` instead.

## References

- ADR 0042 (run caps and the usage ledger), ADR 0041 (rate limits, 429 with Retry-After), ADR 0019 (pool model, `TenantScoped`).
