# ADR-0044: Conversations, summaries and the context window

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

Until Step 4.7 every chat message was its own run with no knowledge of earlier ones (ADR 0039). The build plan asks for trimming and summarization so that long conversations stay within context. Two things can overflow the window (16,384 tokens locally, shared with up to 4,096 of output, so 12,288 for a prompt): a long conversation, and one run with many tool results (8,000 characters each, ADR 0011). A local server does not refuse a long prompt; it drops part of it.

Measured on 2026-11-23 with the local model's own token counts:

- Characters per token: English 4.6, tool definitions 3.3, JSON tool results 2.0, object ids 1.0, Hindi 2.2; an emoji is about 2.5 tokens. One 8,000-character JSON result is about 4,000 tokens. The 35-tool owner menu is 6,471 tokens, the 13-tool one 2,935.
- A short call with thinking on spent all 120 output tokens on thinking and answered nothing; with `reasoning_effort: "none"` it answered in 10.
- LangChain `trimMessages` (`@langchain/core` 1.4.1) on a single run's messages returned an empty list with `startOn: "human"`, and without it kept a tool result whose call was gone.

## Decision

`POST /runs` takes an optional `conversationId`. A conversation belongs to one tenant, spec, user, role and credential mode (404 for anyone else), and its turns are its run records: the user's message and the final answer, never tool calls or results. A unique partial index on active runs allows one run at a time per conversation (409).

The graph gets a first node, `summarizeHistory`: when the estimated history passes `CONVERSATION_HISTORY_TOKENS` (default 1,500), the newest turns that fit in half of it stay word for word and one model call with thinking off folds the older ones into a summary of at most 400 tokens, saved on the conversation and sent as a labelled user message. Before every model call `fitMessages` builds a trimmed copy of the prompt: older tool results are replaced by a short note, then the latest results are cut; if even that cannot fit, the run ends with `context_full`. Sizes are estimated with rules fitted to the measurements, plus a 10% margin.

## Alternatives considered

### One LangGraph thread per conversation

- The framework's usual way: `thread_id` = conversation, messages accumulate in the checkpoint.
- Not chosen: approvals, resume, the run cap and the tenant checks (ADR 0030) all rely on one thread per run; per-run counters would need a reset on every turn, a paused run would hold the thread, and each checkpoint would store the whole conversation.

### Keep tool calls and results in the history

- The next run could reuse earlier results without calling the tool again.
- Not chosen: a run can end with unanswered tool calls (ADR 0042), results are large and go stale, and they are untrusted text that would be carried into every later run.

### LangChain `trimMessages` or `summarizationMiddleware`

- Not chosen: `trimMessages` cannot trim inside one run (measured above); the docs show the middleware only for `createAgent`, which would replace the graph. The summary node follows the docs' hand-written pattern (a `summary` state key and a node).

### A real tokenizer

- Not chosen: one per model and provider, and a new dependency. On ten samples the estimate was 0.97 to 1.99 times the real count (0.97 is covered by the 10% margin; the tool menu 1.06 to 1.11), so the cost is some unused window. The measurements are for this model only.

### A lock field on the conversation

- Not chosen: a crash would leave it locked. The index frees itself when the run's status changes.

## Consequences

**Positive**

- In a scripted 40-turn conversation (160 prompts) every prompt stayed under its limit, kept the system prompt, and had every tool call followed by its result.
- Live on the local model (`CONVERSATION_HISTORY_TOKENS=1000`): the fifth message triggered one summary call, and the model still recalled a detail that by then existed only in the summary. Prompts stayed between 4,177 and 5,303 tokens.
- The full record stays in the checkpoint, the run and the audit log; only the model's copy is trimmed.
- The summary call counts in the run's cap and in the usage ledger. With no budget for it, or an empty reply, older turns are left out of that run and nothing is lost.
- A demoted user, or a tenant that switched credential mode, cannot read back answers fetched with wider access.

**Negative**

- The agent repeats lookups it already made, because results are not kept.
- A summary can lose or distort a detail. It is model output from a conversation, so it can carry injected text: it has no system authority, and Step 4.9 covers the rest.
- Failed and cancelled turns are left out, so a write made before a run failed is not in the history (the audit log has it).
- A run waiting for approval blocks its conversation until it is decided or cancelled (approval expiry is on the v3 list).
- Narrowing a role's policy does not hide answers that the same user already received under it.
- The platform still offers a role's whole menu on every run (the retrieval of Step 3.2 is not wired into it). With 35 tools that leaves about 4,000 usable tokens for history and results in a 16K window.
- `reasoning_effort: "none"` is documented by Ollama; other providers may reject the value.
- Turns are ordered by run creation time, so API servers with clocks that differ could misplace one.

**Follow-ups**

- Long-term memory (session b, ADR 0045).
- Conversation deletion and expiry are not built.

## References

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (`reasoning_effort`), [MongoDB partial indexes](https://www.mongodb.com/docs/manual/core/index-partial/) (`$in`, `$type`), [LangGraph.js memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory), all read 2026-11-23.
- ADR 0011, 0030, 0039, 0042; `docs/run-events.md`.
