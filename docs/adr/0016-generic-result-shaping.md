# ADR-0016: Generic result shaping: field allowlists in overrides, paging hints first

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

ADR 0011 showed that raw list results overflow a 16K context and confuse a small model, and that shaped results with paging hints fix both. Phase 1 did this by hand per tool. After 2.3a, generated tools returned raw pages: `orders_list` with 3 orders was 2,190 characters against 526 hand-shaped. Facts found in 2.3b:

- Nine host list endpoints share one page shape, `{ items, page, limit, total }`.
- **Truncation cut off the paging hint.** With the list first and `hasMore`/`nextPage` last, a result just over the 8,000-character cap lost exactly the fields that tell the model to fetch more. Phase 1's hand-shaped tools have the same order.
- In an agent run, the model asked for `limit: 100` (the API's maximum) to count delivered orders. It only needed `total`, but the result was truncated and the next prompt grew from 6.1K to 11K tokens. Phase 1's hand tool capped `limit` at 20.

## Decision

1. Every generated tool adds `hasMore` and `nextPage` to a page response, and drops `limit`. **Paging fields come before `items`**, so truncation removes trailing items, never the hint.
2. The overrides file may set `result.fields` per operation: an allowlist applied per item for lists, with dot paths for nested objects (`order.number`). The compiler warns when a field is not in the response schema.
3. Lists keep `_id`, because generated tools chain by id (`refunds_request` takes `orderId`). Detail tools get no allowlist and return everything, as in Phase 1. Free-text `notes` stay out of lists.
4. Shaping is one pure function, `shapeResult`, run in the executor after the response is parsed.

## Alternatives considered

### Automatic shaping without overrides (for example drop long strings and nested arrays)

- Works on any spec with no configuration.
- Not chosen: which fields matter is a judgment about the domain; a heuristic would drop `items` on an order detail or keep a long note. Allowlists are explicit and reviewed. Automatic paging hints are safe because they only add information.

### Supporting more pagination styles (cursor, Link headers, `per_page`)

- Needed for GitHub or Stripe.
- Not now: the host uses page numbers; add a style when a real spec needs it.

### Capping `limit` in the generated schema

- Would have stopped the 100-row request.
- Deferred: it needs a schema patch in the overrides file (rejected in ADR 0014 until a spec needs it). It is now a recorded follow-up with evidence.

## Consequences

**Positive**

- `orders_list` went from 2,190 to 582 characters (1.11x the hand-shaped one); `products_list` 1.29x (both keep `_id`).
- Paging hints survive truncation (checked at 100 rows per page).
- The agent answered a chained question (order, then customer) and a count (382, from `total`) correctly with generated tools.

**Negative**

- Only page-number pagination is recognized.
- Allowlists are manual work per API.
- The 35-tool menu costs about 6.1K prompt tokens per model call (Phase 1: about 1.2K); the first call took 38.8 s.

**Follow-ups**

- A per-tool `limit` cap (schema patch) in the overrides file.
- Phase 3: tool retrieval, to shrink the menu per question.
- Phase 1's hand-shaped tools still put the list first; they are kept only for comparison.

## References

- ADR 0011 (context budget), ADR 0014 (overrides), ADR 0015 (executor).
