# ADR-0024: Retrieval experiments: hybrid search, query rewriting, reranking

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

Step 3.4. The baselines left clear gaps. Tool retrieval hit@5 was 83.7% on the host and 62.5% on GitHub, where the misses share exact words with the right tool ("merge", "lock") but lose to near-duplicates. Policy retrieval missed when the user's words differ from the policy's ("reverse the payment" vs "chargeback"). The plan asks for three standard fixes, measured, keeping only what wins.

Facts checked on 2026-11-21:

- MongoDB documents `$rankFusion` (Reciprocal Rank Fusion inside the database) for 8.0 and later. On our `mongodb-atlas-local:8.0` image (server 8.0.34) it fails with "$rankFusion is not allowed with the current configuration. You may need to enable the corresponding feature flag" (measured). `$search` with an English analyzer and a `token` filter field works on the same image (measured: "chargebacks" matched "chargeback", and the tenant filter applied).
- The RRF formula MongoDB documents is `1 / (rank + 60)` per list, summed, with a fixed constant of 60 and 1-based ranks.
- Ollama documents no rerank endpoint (docs.ollama.com/api/rerank is a 404). Its `/api/chat` documents `format` (a JSON schema), `think` and model options such as `temperature` and `seed`; the pages give no version for them.

## Decision rule (fixed before the first run)

Against the vector baseline, at each dataset's key k (hit@5 for the two tool sets, hit@3 for policies), a variant is kept when:

- it gains at least 2 questions on at least 2 of the 3 datasets, and
- it loses at most 1 question on any dataset, and
- if it adds more than 1,000 ms median per question (a model call), it gains at least 4 questions on at least 2 datasets. Seconds per message must buy a clear win.

The script applies the rule itself, so the verdict cannot be argued after seeing the numbers.

## Decision

**Keep the vector baseline. No variant passed the rule.** Production search stays `vector` for tools and policies, and the selection policy from ADR 0022 is unchanged.

What was built, so the experiment can be re-run (`pnpm --filter @toolbridge/retrieval experiments --save`):

- an Atlas Search (BM25) index next to each vector index, with `tenantId` (and `specId` or `source`) as `token` filter fields, and a `text` field on tool vectors (older vectors were backfilled from the cache, with no model calls),
- `search(..., mode)` on both indexes: `vector` (default), `keyword`, or `hybrid` (top 20 of each, merged by RRF in `rrf.ts`),
- `query/`: a JSON-schema chat client for Ollama (temperature 0, seed 42, thinking off; a repeated call gave identical output), query expansion, and listwise reranking with the local chat model. These are used only by the experiment script.

### Before and after (docs/results/retrieval-experiments.md)

Questions hit at the key k, with gained and lost questions against `vector`:

| variant              | host-store hit@5 (43) | GitHub hit@5 (48) | policies hit@3 (20) | added median ms | keep?    |
| -------------------- | --------------------- | ----------------- | ------------------- | --------------- | -------- |
| vector (baseline)    | 36                    | 30                | 18                  | -               | baseline |
| keyword (diagnostic) | 32 (+2/-6)            | 15 (+4/-19)       | 14 (+0/-4)          | 0               | -        |
| hybrid               | 37 (+3/-2)            | 28 (+6/-8)        | 19 (+1/-0)          | 12              | no       |
| rewrite + vector     | 34 (+0/-2)            | 27 (+1/-4)        | 18 (+0/-0)          | ~2,100          | no       |
| rewrite + hybrid     | 38 (+3/-1)            | 31 (+4/-3)        | 19 (+1/-0)          | ~2,100          | no       |
| rerank (vector)      | 37 (+7/-6)            | 35 (+8/-3)        | 18 (+0/-0)          | ~7,100          | no       |
| rerank (hybrid)      | 39 (+6/-3)            | 33 (+7/-4)        | 20 (+2/-0)          | ~7,000          | no       |

The baseline row reproduces Steps 3.2 and 3.3 exactly (83.7%, 62.5%, 18 of 20), and the Step 3.2 recall script gives the same numbers after this step's changes.

### What the numbers say

- **Every variant fixes some questions and breaks others.** The net gains look good (rerank (hybrid) is +3, +3 and +2), but each variant loses 2 to 8 questions that worked before. The rule counts losses on purpose: a user whose working question breaks does not care that someone else's started working.
- **Hybrid** fixed the word-mismatch misses it was meant for (k12 "reverse the payment", host h12, h26, h29), and on GitHub it fixed six questions. But it lost eight others. In the ones checked (g01, g10, g14, g17), the right tool was at rank 5 in vector search, on the edge, and keyword search matched incidental words with unrelated tools ("login page crashes" found `markdown_render`, "touched in PR" found `repos_delete_file`), which pushed the right tool to rank 6. Keyword alone gets only 15 of 48 there: on 1,281 tools, everyday words match too much.
- **Reranking is the strongest idea but the slowest:** GitHub hit@3 went from 23 to 34 with rerank (vector). It lost all three short follow-ups (h41 to h43, "ok, cancel it"), because the reranker sees the request without the conversation. At about 7 s per message on this laptop it needed a clear win, and it lost too many questions to get one.
- **Rewriting alone did not help:** a 4B model writing search words loses as often as it gains. Combined with hybrid it was nearly a pass (+3/-1, +4/-3, +1/-0), but GitHub lost 3.

## Alternatives considered

### `$rankFusion` in the database

- One query instead of two, and the fusion runs next to the data.
- Not available: it is behind a feature flag on our image. RRF in code is 20 lines over two queries, and the formula is the documented one, so moving to `$rankFusion` later is a swap, not a redesign.

### Score fusion (normalize and add the scores)

- Uses how sure each side is, not only the order.
- Rejected: BM25 scores are unbounded and cosine scores are bunched between 0.7 and 0.9, so normalization is a guess that needs tuning. RRF needs none. MongoDB's `$scoreFusion` needs 8.3.

### A dedicated reranker model (for example Qwen3-Reranker, or a hosted API)

- Purpose-built, usually better and faster than a chat model asked to rank.
- Not tried: Ollama has no rerank endpoint and none in its official library, and a hosted API costs money and sends data out. Our listwise rerank with the local chat model is a fair test of the idea, not of the best reranker.

### HyDE (embed a hypothetical answer instead of the question)

- Puts the query in the same "language" as the documents.
- Not tried: it needs a longer generation (slower on this laptop) and our rewrite covers the same vocabulary gap more cheaply. A candidate if rewriting wins.

## Consequences

**Positive**

- The baseline is confirmed as the right default by a rule fixed in advance, not by opinion. The table can be regenerated from one command.
- The experiment harness (modes, RRF, rewrite, rerank) is in place for the next attempt: a held-out set, a dedicated reranker, or a faster GPU change the trade-off, not the code.

**Negative**

- Every index now builds and maintains a keyword index that production search does not use. It costs a little disk and indexing work. Remove it, or switch production to hybrid, when the next experiment decides.
- 111 questions, all written by Claude Code, decide this. A swing of 2 questions is within noise, so "no" here means "not clearly better", not "worse".

**Follow-ups**

- Re-run with Vijay's held-out questions when they exist.
- Reranking: try it only on top-k misses (when the top score is weak), which would cut the 7 s cost on most messages, and pass the previous user message for follow-ups.
- Hybrid: try a lower keyword weight (for example 0.5) on large specs, decided on a held-out set, not on this one.

## References

- MongoDB hybrid search and `$rankFusion`: https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/ and https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankfusion/
- Atlas Search `text` operator: https://www.mongodb.com/docs/atlas/atlas-search/text/
- Atlas Search field mappings (`token` for `equals`): https://www.mongodb.com/docs/atlas/atlas-search/define-field-mappings/
- Ollama chat API: https://docs.ollama.com/api/chat
- ADR 0021 (tool index), ADR 0022 (tool selection), ADR 0023 (knowledge RAG)
