# ADR-0011: 16K context, shaped list results, and an 8,000-character result cap

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

Step 1.4b's failure lab measured what large tool results do to the local model (`qwen3.5:4b`, 16K context, RTX 2050 with 4 GB VRAM):

- **Oversized result:** one raw page of 100 orders (59,122 characters) made the prompt bigger than the context window. Ollama processed only **166 prompt tokens**: it silently dropped the whole tool message and kept the system prompt and the last question. The model replied that it had no order list. There was no error.
- **Raw but truncated:** cutting the same result to 8,000 characters got the right order number but a total off by 10× ($51.39 instead of $513.91). Raw orders contain many cent fields, and the small model mixed them up.
- **Shaped, then truncated:** a compact summary per order gave the right answer ($513.91). 100 shaped orders take 15,377 characters against 59,122 raw.
- **Pagination:** with raw pages, a 50-order question was too slow to finish (stopped by hand). With shaped pages and `hasMore`/`nextPage` hints, the model fetched exactly 3 pages and the prompt stayed at 4.8K tokens. It then spent minutes adding 50 numbers in its thinking and hit the 7-minute cap, even though it had reached the right total.
- **Context sizes** (5,083-token prompt, thinking off):

| num_ctx | Memory  | On GPU | Prompt tok/s | Output tok/s |
| ------- | ------- | ------ | ------------ | ------------ |
| 8K      | 3.62 GB | 48%    | 934          | 10.5         |
| 16K     | 3.93 GB | 44%    | 883          | 10.9         |
| 32K     | 4.56 GB | 38%    | 859          | 11.3         |

Changing `num_ctx` reloads the model (about 11 s each time).

## Decision

1. Keep **16K** as the default context (the Modelfile and `LLM_CONTEXT_LENGTH` don't change).
2. List tools **shape** their results: a few key fields per item, plus `{ page, total, hasMore, nextPage }`. Detail stays in the get-one tools. Free-text notes are left out of lists.
3. The executor **caps every tool result at 8,000 characters**, adding an explicit truncation note. That's about 2K tokens, room for several results.

## Alternatives considered

### 32K context

- More room for long chats.
- Rejected for now: it uses 0.63 GB more memory and moves more of the model to the CPU, on a 16 GB machine shared with MongoDB, Redis and the editor. Prompt speed barely changes, so this can be revisited if chats routinely approach 16K.

### 8K context

- The least memory and the most GPU use.
- Rejected: the tool menu, system prompt and three shaped pages already reach about 4.8K tokens.

### Truncation only, no shaping

- Generic, with no per-tool code.
- Rejected: the lab showed truncated raw data still produces wrong numbers. Shaping removes the confusing fields.

### Let the model page through everything

- No extra tools.
- Rejected for aggregates: the model reached the right sum but took minutes and never finished answering. Totals and counts belong in API aggregate endpoints or calculator-style tools.

## Consequences

**Positive**

- No silent data loss from a single huge result.
- Smaller, cleaner results are faster to process and easier for a small model to read.

**Negative**

- Shaping is hand-written per list tool. Phase 2's generated tools will need a generic way to do it (response field selection in the spec compiler).
- Truncated JSON is invalid JSON. The note explains the gap, but the model sees partial data.
- Aggregate questions are still slow until an aggregate tool exists.

**Follow-ups**

- Step 2.2: drop response-only and noisy fields when generating tools, and expose the host's report endpoints as tools.
- Phase 3 or 4: consider a calculator or aggregation tool for sums over paged data.

## References

- https://docs.ollama.com/api/chat
- https://docs.ollama.com/api/ps
- https://docs.ollama.com/context-length
- ADR-0007, ADR-0008
