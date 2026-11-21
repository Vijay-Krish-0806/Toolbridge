# ADR-0023: Knowledge RAG with heading chunks, a search tool, and checked citations

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

Step 3.3. Staff ask rule questions ("can support approve a refund?", "when is a parcel lost?") that no API answers. A model answering them from memory invents policy. We need the store's policy documents retrieved and quoted, with a source the reader can check.

The handbook (`learning-app/content/`) has no page on RAG or chunking yet, so there was nothing to follow and nothing conflicts.

## Decision

1. **Content:** three fictional policies in `knowledge/host-store/` (refund policy, shipping rules, escalation guide). Every rule the host API enforces is stated exactly as the code enforces it and marked "(enforced by the API)", for example refunds only for shipped or delivered orders, and only the owner approves them. The rest (30-day window, carrier choice, escalation triggers) is invented store policy.
2. **Chunk by heading.** One chunk per section, with metadata: a stable id `<file>#<heading-slug>` (the citation), the document title and the heading path. The embedded text is the heading path plus the section text, so a section like "within 7 days" is found by its topic. A section over 1,500 characters is split at paragraph breaks into `-part-2`, `-part-3`. The splitter is about 60 lines and line-based (headings outside code fences). No markdown library: we write the files, so a parser is a dependency we don't need.
3. **Storage:** a `knowledge_chunks` collection with a vector index pre-filtered on `tenantId` and `source`. It uses the same incremental reindex by text hash and the same embedding cache as the tool index. The text and metadata sit next to the vector, so one search returns everything needed to show and cite a passage. Index creation, waiting and candidate sizing moved into a shared `vector-index.ts`, used by both indexes (the 3.1 acceptance check still passes).
4. **Query instruction per index:** `embedQuery(query, instruction?)`. Policy search uses "Given a question from store staff, retrieve the policy passages that answer it"; the tool index keeps its own. Stored vectors never change with the instruction.
5. **Retrieval as a tool:** `knowledge_search(query)` returns 4 passages `{ id, section, text }` and repeats the citation rule. It lives in agent-core behind a `KnowledgeSearcher` port. With `--retrieve`, it joins the always-offered core set, because the tool index holds only API tools. The system prompt gets three extra rules only when the tool is offered: search before answering a rule question, cite ids in square brackets, and say when the policies don't cover something.
6. **Citations are checked, not trusted.** `checkCitations` takes the ids cited in the answer and splits them into **grounded** (returned by `knowledge_search` in this run) and **ungrounded** (invented, or remembered from an earlier turn). The chat prints both; the eval grades on them.

## Results (docs/results/knowledge-rag.md)

24 chunks from 3 documents. Ingest check (`knowledge:check`): 24 embedded from empty, 0 when unchanged, 1 after editing one section, 1 from cache after reverting, 1 removed. The model is qwen3.5:4b, every generated tool is offered plus `knowledge_search`, and each question runs in a fresh conversation.

|                                                    | result                       |
| -------------------------------------------------- | ---------------------------- |
| Retrieval alone, 20 questions: hit@1 / @3 / @5     | 65 / 90 / 90%                |
| End to end, 23 questions, correct (3 runs)         | 16, 16, 17 (saved run 73.9%) |
| Cited answers with any ungrounded id (3 runs)      | **0** of 16, 17, 17          |
| Not-covered questions answered as such (saved run) | 3 of 3                       |
| Mean input tokens per question                     | ~14K (full tool menu)        |

Further findings:

- **The model did not invent sources.** Over three runs, every cited id had been retrieved in that run. The misses are wrong or missing sources, never made-up ones.
- **Run-to-run variance is large.** The total stayed at 16 or 17, but which questions failed changed between runs. For example, k03 and k09 failed in run 1 and passed in run 2. A single run says little about a single question.
- **Four failure kinds:**
  - **Retrieval ranked the wrong section** (k12, k18): the words differ from the policy ("call their bank to reverse the payment" vs "chargeback"; "send the refund to a different account" vs "suspected fraud").
  - **Answered without searching** (k19, k20): mixed questions. k19 took the cancel rule from the `orders_cancel` tool description, which states the same rule.
  - **Answered without citing** (k03 in run 3): the new citation warning flags it.
  - **Empty answer** (k02, k20 in run 2): the model ended its turn with reasoning only and no text.
- **The grader had a bug.** The first "not covered" phrase list marked two correct answers wrong ("I cannot find any information…"). After widening the list, it matches exactly the 3 not-covered answers and none of the 20 policy answers in the saved run. That fixed the measurement; it did not change the model or the prompt.
- **With tool retrieval** (`--retrieve 5 --knowledge`), a live damaged-item question used 5,345 input tokens and cited the right section. `knowledge_search` was in the menu as a core tool.

## Alternatives considered

### Fixed-size chunks with overlap (for example 500 tokens, 50 overlap)

- Works on any text, including documents with no headings.
- Rejected: it cuts sections mid-rule and gives no natural citation. Our documents are short and already split into topics by their authors.

### Semantic chunking (split where the embedding of consecutive sentences changes)

- Finds topic breaks in unstructured text.
- Rejected: it needs an embedding call per sentence at ingest, and the headings already mark the breaks.

### Inject passages automatically on every turn (classic RAG)

- The model never forgets to search.
- Rejected for now: it costs tokens on every order question, and the plan asks for a tool. Worth comparing in Step 3.4 if the model often skips the search.

### Put chunks in the tool index (one index for everything)

- One search instead of two.
- Rejected: tools and passages are different things with different queries and lifecycles. The selector would also mix passages into the tool menu.

### A markdown parser (remark / mdast)

- Handles every markdown edge case.
- Rejected: one more dependency for files we write ourselves. Revisit if tenants upload their own documents.

## Consequences

**Positive**

- Rule answers come with a checkable source, and an invented source is caught by code, not by a reader.
- Editing one policy section re-embeds one chunk (measured: 1 embedded, 23 unchanged).

**Negative**

- The questions were written by Claude Code, which also wrote the policies, so retrieval numbers may be optimistic.
- The "not covered" grade uses a phrase list. The answers are saved in the JSON for reading.
- Knowledge is a local folder per source. There is no upload endpoint for tenants yet.
- Citations point to a section, not a sentence: a long section only proves the source contains the claim somewhere.

**Follow-ups**

- Step 3.4: hybrid keyword search, query rewriting and reranking, measured against this baseline too (k12 and k18 are word-mismatch misses).
- An empty-answer guard in the loop: when the model ends a turn with reasoning but no text, ask it once more for the answer.
- Mixed questions: the model skips the policy search when the data alone seems to answer. Worth a prompt rule or auto-injection test in 3.4.
- Later (outside the current plan): tenant upload of knowledge documents through the platform API.

## References

- Qwen3-Embedding-0.6B model card (query instructions): https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- ADR 0021 (tool index), ADR 0022 (tool selection)
