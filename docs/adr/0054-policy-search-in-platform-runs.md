# ADR-0054: Policy search in platform runs, with the operator's documents and checked sources

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Step 3.3 built policy search with citations (ADR 0023), but only the command-line chat used it. The store's chat could not answer "how long after delivery can a customer get a refund?". The index already has a tenant and a source per passage, and the host policy already allows `knowledge_search`. Document upload by tenants is on the v3 list.

## Decision

- **Scope:** the tenant and the spec of the run. It is fixed when the tool is built, so the model can only ask; arguments that name another scope are ignored.
- **Offered** only when that API has documents and the role's policy allows `knowledge_search`. A tenant's own tool of that name wins. Only then does the prompt get the three policy rules.
- **Documents** are loaded by an operator command (`knowledge:load`), which first checks that the spec belongs to the tenant. Running it again embeds only changed sections; `--clear` removes them.
- **A local tool** (like `memory_save`): it runs inside the platform, needs no credential of the tenant's API, and does not count in its breaker, rate or cache. Every search is in the audit log.
- **Its text is trusted:** only the operator can load it, so reading a rule does not raise the exposure (ADR 0047). Data from the API still does.
- **A failing search** is logged and becomes a fixed error text for the model. The run goes on.
- **Sources are checked by code.** `run_finished` gets `sources` (cited and really retrieved in this run, over all legs) and `sourceWarning` (an invented source, or none although it searched). Both optional, so the event schema stays version 1. The widget shows them.
- **Indexes are rebuilt at startup only when documents exist.**

## Alternatives considered

### Search on every message and put the passages into the prompt

- The model cannot forget to search.
- Not chosen: tokens on every order question, and it was not chosen in ADR 0023 either.

### Treat policy text as untrusted

- Safer if tenants upload documents one day.
- Not chosen now: after one rule question, every write of the conversation would need a person. **Must be decided again before tenants can upload.**

### A tenant upload API

- Not chosen: on the v3 list, and it changes the trust decision above.

### Always build the indexes at startup

- Simpler.
- Not chosen: every fresh database (one per e2e test file) would build and wait for two more search indexes it never uses. The gain was not measured fairly: one slow suite run happened on battery power, so it proves nothing.

## Consequences

**Positive**

- Policy questions work in the store's chat, with sources a person can check.
- Isolation, RBAC, approvals and source checks are tested with a fake embedding server (7 e2e tests; 11 of 11 rules broken on purpose were noticed, two only after the tests were improved).

**Negative**

- Runs with documents carry about 330 more prompt tokens (our estimate, 212 to 541 for prompt and this tool).
- Answer quality is not measured here. On the 4B model Step 3.3 measured 73.9% of 23 questions, and 0 of 2 that mix a rule with an order.
- If only the MongoDB container restarts, its search indexes are gone until the API restarts. A search then finds nothing, and the model may say that the policies do not cover it.
- An answer that repeats a source from an earlier message without searching again gets a warning.
- The check proves that a passage was retrieved, not that the answer says what it says.

**Follow-ups**

- Measure answers on a stronger model (owner's plan for the end of the project).

## References

- ADR 0023 (knowledge RAG), 0026 (roles), 0035 (events), 0045 (local tools), 0047 (exposure).
