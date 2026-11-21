# ADR-0022: Tool selection per request (top-k, core set, widen-k fallback) and a recall@k eval

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

Step 3.2. The agent loop sends every registered tool on every model call. That is about 5.4K tokens for the 35 host tools (a third of our 16K context), and about 448K tokens for GitHub's 1,281 tools, which cannot run at all. Step 3.1 built a vector index of the tools (ADR 0021). This step decides how the loop uses it, and measures how often the right tools are offered.

Facts checked on 2026-11-21:

- The Qwen3-Embedding-0.6B model card recommends a one-sentence task instruction on queries only, as `Instruct: {task}\nQuery:{query}`, and says documents need none. It claims a 1% to 5% gain. Its code example has no space after `Query:`, and its TEI example has one; we follow the code example.
- The GitHub spec is `descriptions/api.github.com/api.github.com.2026-03-10.json` from github/rest-api-description (main at c9c95fe, sha256 `b1abdc80…`). It compiles to 1,281 tools in 1.4 s.

## Decision

1. **Port in agent-core:** `ToolSelector.select(query) → { names, mode, topScore? }`. agent-core has no MongoDB code; `VectorToolSelector` in packages/retrieval matches the port by shape.
2. **Select once per user message.** The query is the latest user message, and the menu stays fixed for the whole run. A call to a registered tool outside the menu is refused with an `unknown_tool` error and is never run. The menu is the run's permission boundary, and a unit test guards it. We checked the test by removing the guard: it failed.
3. **Policy (`DEFAULT_SELECTOR`):** top k = 5, plus a core set that is always offered (host: `orders_get`, chosen before measuring). If the top-1 score is below 0.85, widen to 15 (Vijay chose widening over a meta-tool).
4. **Query instruction:** "Given a user request, retrieve the API tools that can fulfil it", set by `EMBEDDING_QUERY_INSTRUCTION`. Tool texts stay unchanged, so changing the instruction never re-embeds anything.
5. **Eval:** `evals/retrieval/{host-store,github}.json` hold labelled questions. Each `expect` entry is a group of acceptable tools, and a question needs one tool from every group. Each set also has 6 off-topic questions. `pnpm --filter @toolbridge/retrieval recall --save` writes `docs/results/retrieval-baseline.{md,json}`. Those files record the spec hashes, dataset hashes, model, instruction and policy.
6. `ToolIndex.waitUntilSearchable` exists because the vector index is eventually consistent. The first chat question after a fresh index found **no** tools until we added this wait.

## Baseline (docs/results/retrieval-baseline.md)

|                                    | host (35 tools, 43 questions)    | GitHub (1,281 tools, 48 questions) |
| ---------------------------------- | -------------------------------- | ---------------------------------- |
| hit@1 / @3 / @5 / @10 / @20        | 62.8 / 76.7 / 83.7 / 93.0 / 100% | 33.3 / 47.9 / 62.5 / 75.0 / 81.3%  |
| policy hit (k 5 + core + fallback) | **93.0%**, ~979 tokens per menu  | **62.5%**, ~1,916 tokens per menu  |
| full menu                          | ~5,376 tokens                    | ~447,603 tokens                    |

Further findings:

- **Host, by tag:** single-tool questions reach 100% hit@3. Multi-step questions reach only 46% hit@5, because the lookup step ("find the order or customer first") ranks low. The core set fixes most of those cases.
- **Live run** (host, "Where is the package for ORD-10343?"): 25,832 input tokens with the full menu, 4,287 with retrieval. Both runs gave the same correct answer.
- **The confidence signal is weak.** Off-topic questions score up to 0.823 (host) and 0.858 (GitHub), while labelled questions go as low as 0.798 and 0.822. On GitHub, no threshold from 0 to 0.89 changed the hit rate: misses there come with _high_ top scores, because near-duplicate tools outrank the right one (for example `pulls_merge_async` above `pulls_merge`). On the host, 0.85 added 2.3 points for about 134 more tokens per menu.

## Alternatives considered

### Select again on every model call

- The menu could follow the conversation as tool results arrive.
- Rejected: the model plans several steps ahead, and a menu that changes between steps can hide the tool it meant to call next. It would also cost one embedding call per step.

### A `search_tools` meta-tool

- The model asks for more tools when it can't find one, which handles misses during a run.
- Rejected for now (Vijay's call): a 4B model has to recognize when to use it. Worth revisiting for large specs, given GitHub's 62.5%.

### Use the whole conversation as the query

- Would help follow-ups like "ok, cancel it".
- Not needed yet: all 3 follow-up questions hit@1, because "cancel" and "approve" carry the meaning on their own. Long conversations would also dilute the query.

### An absolute "no tool fits" threshold (offer nothing)

- Would save tokens on small talk.
- Rejected: off-topic and real questions overlap in score, so it would hide tools from real questions.

## Consequences

**Positive**

- On the host, a ~1K-token menu replaces ~5.4K at a 93% policy hit rate. On GitHub, the agent can run at all.
- The baseline can be reproduced from one command, against pinned spec and dataset hashes.

**Negative**

- **Possible optimistic bias:** the questions were written by Claude Code, which had read the tool descriptions. The threshold was also tuned on the same questions it is scored on, and there is no held-out set.
- GitHub at 62.5% means more than a third of questions don't get their tool in the menu. Retrieval alone is not good enough for large specs.
- Selection does not yet filter out disabled tools. The platform has no agent-run endpoint yet; that comes with Phase 4.
- The core set lives in the chat CLI and the eval script as constants. There is no per-spec configuration yet.

**Follow-ups**

- Step 3.4: hybrid keyword + vector search (GitHub misses share exact words like "merge", "lock", "fork"), query rewriting and reranking. Measure each against this baseline, and add held-out questions written by Vijay.
- Phase 4: enabled and RBAC filtering inside selection, and per-spec core sets in platform settings.

## References

- Qwen3-Embedding-0.6B model card: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- GitHub REST API description: https://github.com/github/rest-api-description
- ADR 0021 (tool index), ADR 0009 (framework-free agent loop)
