# ADR-0021: Tool index with local embeddings, an embedding cache and Atlas Vector Search

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

Step 3.1. Every model call sends all 35 host tools, about 6.1K of a 16K context (Phase 2 review). Large public specs compile to hundreds of tools, which cannot fit at all. Step 3.2 will send only the tools that match the question, and this step builds the index it searches. Requirements: tenant isolation (pool model, ADR 0019), the index follows spec uploads, and changing one operation re-embeds only that operation.

Facts checked on 2026-11-21:

- Ollama 0.40.16 `POST /api/embed` takes `input` as a string or an array of strings, plus `dimensions` and `truncate`, and returns `embeddings` (docs.ollama.com/api/embed).
- `qwen3-embedding:0.6b` (639 MB, 32K context) returns **1024**-dimension vectors of length 1.0. Measured; the Ollama library page does not state the 0.6b size.
- Atlas Local 8.0, which is already in `infra/docker-compose.yml`, accepts `createSearchIndex({ type: 'vectorSearch' })` from the Node driver. The index became queryable in about 1 s, and `filter` fields and `{ $meta: 'vectorSearchScore' }` work. Measured with a probe script.
- Right after a collection is dropped, `listSearchIndexes` still lists the old index for a moment with status `DOES_NOT_EXIST`. We observed this; it is not documented on the pages we read.

## Decision

1. A new package, `packages/retrieval`, defines an `EmbeddingProvider` port (`model`, `dimensions`, `embed(texts)`). The one adapter calls Ollama's `/api/embed` with `fetch`, `truncate: false`, a fixed `dimensions`, and a length check on every vector.
2. `buildToolText` (pure) embeds the tool name with spaces, the description, and each argument's name, description and short enum list. Argument words such as "amountCents" or "damaged" are often what a question uses.
3. The `embeddings` collection is a content-addressed cache keyed by `sha256(model + dimensions + text)`, shared across tenants like the compile cache (ADR 0017).
4. The `tool_vectors` collection stores one document per tool: `{ tenantId, specId, toolName, textHash, vector, safety }`. One Atlas `vectorSearch` index covers it, with cosine similarity over 1024 dimensions and `tenantId` and `specId` declared as filter fields. Search pre-filters on them, so the search only ever sees one tenant's tools.
5. `reindex(scope, tools)` compares each tool's `textHash` with the stored one. It embeds only changed or new tools (cache first), upserts them and deletes vectors of tools that left the spec. It returns `{ total, unchanged, fromCache, embedded, removed }`.
6. The platform reindexes **synchronously** after `register` and `addVersion` save the version (Vijay's call for now). If the reindex fails, the upload still succeeds: the response says `index.status: 'stale'`, and the real error is only logged. The saved version is the source of truth, and the next upload heals the index, because the hash comparison re-embeds whatever is out of date.
7. `ensureIndexes` runs at startup. It treats a `DOES_NOT_EXIST` or `DELETING` entry as missing, refuses an existing index built for a different vector size, and waits until the index is queryable.
8. Enabled or disabled state is not stored in the index. It changes without a spec upload, so Step 3.2 filters by the tenant's tool settings at query time.

## Alternatives considered

### A separate vector database (Qdrant, pgvector)

- Purpose-built, and pgvector gives real transactions with the relational data.
- Rejected for now: one more service on a 16 GB laptop. MongoDB already holds the tools, and Atlas Local includes vector search. The stack table in the build plan suggests a comparison ADR; tool counts in the hundreds do not need it.

### An in-memory index (brute-force cosine in Node)

- Exact, simple, and fast enough for a few hundred vectors.
- Rejected: it is rebuilt on every start, it is per process (no sharing between API and workers in Phase 4), and the step asks for a database index.

### Embed only the description

- Shorter text, and cheaper.
- Rejected: argument names and enum values carry meaning. The text builder is one function, so Step 3.4 can measure variants.

### Reindex in a worker queue

- Keeps uploads fast and adds retries.
- Deferred to Phase 4 (BullMQ). The synchronous version measured 1.7 s for 35 tools with a warm model, and 10 s when the model also had to load.

### Fail the upload when embedding fails

- Simpler to reason about, because index and version can never disagree.
- Rejected: an Ollama outage would block every spec upload, although the index can be rebuilt from the saved version at any time.

## Consequences

**Positive**

- Measured with `index:check` (35 host tools): a first index embedded 35 tools in 1.7 s with a warm model. An unchanged reindex embedded 0 (11 ms). Editing one description embedded 1 (89 ms). Reverting the edit came from the cache, 0 embedded. A dropped tool deleted 1 vector.
- Through the platform API, a version with one changed operation description reported `embedded: 1, unchanged: 34`. The Step 2.4 diff reports `changed: 0` for the same edit, because descriptions are not part of the contract. The tool index still picks them up.
- First searches ranked the right tool first for four sample questions, for example "refund a damaged order" → `refunds_request` 0.909.

**Negative**

- Scores are tightly bunched. The fourth-ranked tool is often within 0.1 of the first, so a fixed score threshold will be fragile in Step 3.2.
- The index is eventually consistent. A vector written a moment ago may not be found for a short time.
- Changing the model or the dimensions means dropping the vector index and re-embedding everything. The cache key keeps old vectors from being mixed in, but nothing migrates them automatically.
- Uploads now wait for embedding, and the e2e suite needs Ollama to exercise the indexed path. Without Ollama it still passes, and the index shows `stale`.
- `tool_vectors` is accessed through its own class, not through `TenantScoped`, so tenant filtering there relies on that one class.

**Follow-ups**

- Step 3.2: Qwen3's recommended query instruction prefix (not verified yet), top-k plus a core set, the low-confidence fallback, recall@k, and filtering by enabled tools.
- Phase 4: move the reindex to a worker, and add an admin "reindex" action for indexes marked `stale`.

## References

- Ollama embed API: https://docs.ollama.com/api/embed
- qwen3-embedding: https://ollama.com/library/qwen3-embedding
- Vector Search index definition: https://www.mongodb.com/docs/vector-search/indexes/vector-search-type/
- `$vectorSearch` stage (`numCandidates` ≥ 20 × `limit`, at most 10,000): https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/
- ADR 0017 (content-addressed cache), ADR 0019 (pool model)
