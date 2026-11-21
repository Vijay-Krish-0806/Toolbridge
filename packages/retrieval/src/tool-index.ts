/**
 * The tool index: one vector per tool, per tenant and spec, searchable with Atlas Vector Search.
 * Reindexing is incremental: each stored vector remembers the hash of the text it came from, so
 * only tools whose text changed are re-embedded, and the embedding cache catches texts we have
 * seen before (for example an edit that was reverted).
 *
 * Tenant isolation: every query and write here filters on tenantId. The vector index declares
 * tenantId and specId as filter fields, so the search itself is pre-filtered to one tenant's tools;
 * it never ranks another tenant's tools and drops them afterwards. The keyword index (Step 3.4)
 * does the same with `equals` filters.
 */
import type { ToolDefinition } from '@toolbridge/spec-compiler';
import type { Collection, Db } from 'mongodb';

import { EmbeddingCache, embeddingKey, vectorsFor } from './embedding-cache.js';
import type { EmbeddingProvider } from './embedding/provider.js';
import { reciprocalRankFusion } from './rrf.js';
import { buildToolText } from './tool-text.js';
import {
  ensureTextIndex,
  ensureVectorIndex,
  numCandidates,
  type VectorIndexSpec,
  waitFor,
} from './vector-index.js';

/** Which tools: one spec of one tenant. Plain strings, so this package does not depend on BSON ids. */
export interface IndexScope {
  tenantId: string;
  specId: string;
}

interface ToolVector {
  tenantId: string;
  specId: string;
  toolName: string;
  /** The embedding cache key of the text this vector came from (model + dimensions + text). */
  textHash: string;
  /** The text that was embedded, kept for keyword search and reranking (Step 3.4). */
  text: string;
  vector: number[];
  safety: ToolDefinition['safety'];
  updatedAt: Date;
}

export interface ReindexSummary {
  total: number;
  /** Text unchanged since the last reindex: nothing to do. */
  unchanged: number;
  /** Text changed (or new tool), and the vector was already in the embedding cache. */
  fromCache: number;
  /** Text changed (or new tool), and the model had to embed it. */
  embedded: number;
  /** No longer in the spec: vector deleted. */
  removed: number;
}

export interface ToolMatch {
  toolName: string;
  /**
   * Higher is better, on the scale of the search mode: vector, the Atlas Vector Search score
   * (0 to 1); keyword, the BM25 score (unbounded); hybrid, the RRF score (about 0.03 at most).
   */
  score: number;
  /** The tool's indexed text, for reranking. */
  text: string;
}

/**
 * How to search (Step 3.4). `vector`: meaning only (the 3.1 baseline). `keyword`: BM25 on the tool
 * text only. `hybrid`: both, merged with Reciprocal Rank Fusion.
 */
export type SearchMode = 'vector' | 'keyword' | 'hybrid';

/** Results each side contributes before hybrid fusion: enough depth for RRF to work with. */
const FUSION_DEPTH = 20;

const VECTOR_INDEX: VectorIndexSpec = {
  name: 'tool_vectors_vector',
  filterPaths: ['tenantId', 'specId'],
};
const TEXT_INDEX = {
  name: 'tool_vectors_text',
  textPaths: ['text'],
  filterPaths: ['tenantId', 'specId'],
};

export class ToolIndex {
  private readonly vectors: Collection<ToolVector>;
  private readonly cache: EmbeddingCache;

  /** Uses the `tool_vectors` and `embeddings` collections of the given database. */
  constructor(
    db: Db,
    private readonly provider: EmbeddingProvider,
  ) {
    this.vectors = db.collection<ToolVector>('tool_vectors');
    this.cache = new EmbeddingCache(db);
  }

  /**
   * Creates the unique index, the vector search index and the keyword index if they are missing,
   * then waits until both search indexes can be queried (details in vector-index.ts).
   */
  async ensureIndexes(timeoutMs = 60_000): Promise<void> {
    await this.vectors.createIndex(
      { tenantId: 1, specId: 1, toolName: 1 },
      { unique: true },
      undefined,
    );
    await ensureVectorIndex(this.vectors, VECTOR_INDEX, this.provider, timeoutMs);
    await ensureTextIndex(this.vectors, TEXT_INDEX, timeoutMs);
  }

  /**
   * Brings one spec's vectors in line with its current tools.
   * Before -> after: 35 indexed tools, one description edited ->
   * `{ total: 35, unchanged: 34, fromCache: 0, embedded: 1, removed: 0 }`.
   */
  async reindex(scope: IndexScope, tools: ToolDefinition[]): Promise<ReindexSummary> {
    const stored = await this.vectors
      .find(scope, {
        projection: { _id: 0, toolName: 1, textHash: 1, hasText: { $toBool: '$text' } },
      })
      .toArray();
    // Vectors written before Step 3.4 have no `text`: rewrite them once (from the cache, no model call).
    const storedHash = new Map(
      stored.map((v) => [v.toolName, (v as { hasText?: boolean }).hasText ? v.textHash : '']),
    );

    const changed = tools
      .map((tool) => {
        const text = buildToolText(tool);
        return { tool, text, key: embeddingKey(this.provider, text) };
      })
      .filter(({ tool, key }) => storedHash.get(tool.name) !== key);

    const { vectorOf, embedded } = await vectorsFor(this.cache, this.provider, changed);

    const updatedAt = new Date();
    if (changed.length > 0) {
      await this.vectors.bulkWrite(
        changed.map(({ tool, text, key }) => ({
          updateOne: {
            filter: { ...scope, toolName: tool.name },
            update: {
              $set: {
                textHash: key,
                text,
                vector: vectorOf.get(key) ?? [],
                safety: tool.safety,
                updatedAt,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    const { deletedCount } = await this.vectors.deleteMany({
      ...scope,
      toolName: { $nin: tools.map((t) => t.name) },
    });

    return {
      total: tools.length,
      unchanged: tools.length - changed.length,
      fromCache: changed.length - embedded,
      embedded,
      removed: deletedCount,
    };
  }

  /**
   * The k tools of one spec that best match a query, best first.
   * `vector`: approximate (HNSW) search over 20 x k candidates, the ratio the Atlas docs recommend.
   * `keyword`: BM25 over the tool text, English stemming. `hybrid`: the top 20 of each, merged
   * with RRF. Both indexes are eventually consistent: a tool written a moment ago may be missing.
   * Before -> after: `'refund a damaged order', 3` ->
   * `[{ toolName: 'refunds_request', score: 0.8, text: 'Tool: refunds request ...' }, ...]`
   * (scores illustrative).
   */
  async search(
    scope: IndexScope,
    query: string,
    k: number,
    mode: SearchMode = 'vector',
  ): Promise<ToolMatch[]> {
    if (mode === 'vector') return this.vectorSearch(scope, query, k);
    if (mode === 'keyword') return this.keywordSearch(scope, query, k);
    const depth = Math.max(k, FUSION_DEPTH);
    const [byMeaning, byWords] = await Promise.all([
      this.vectorSearch(scope, query, depth),
      this.keywordSearch(scope, query, depth),
    ]);
    const textOf = new Map([...byMeaning, ...byWords].map((m) => [m.toolName, m.text]));
    return reciprocalRankFusion([
      { ids: byMeaning.map((m) => m.toolName) },
      { ids: byWords.map((m) => m.toolName) },
    ])
      .slice(0, k)
      .map(({ id, score }) => ({ toolName: id, score, text: textOf.get(id) ?? '' }));
  }

  /** Semantic search: the query's embedding against the tool vectors. */
  private async vectorSearch(scope: IndexScope, query: string, k: number): Promise<ToolMatch[]> {
    const queryVector = await this.provider.embedQuery(query);
    return this.vectors
      .aggregate<ToolMatch>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX.name,
            path: 'vector',
            queryVector,
            numCandidates: numCandidates(k),
            limit: k,
            filter: { tenantId: scope.tenantId, specId: scope.specId },
          },
        },
        { $project: { _id: 0, toolName: 1, text: 1, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
  }

  /**
   * Keyword search: BM25 over the tool text, pre-filtered to one tenant's spec with `equals`
   * (a filter clause does not affect the score). Finds exact words that embeddings blur, such as
   * "merge" or "lock".
   */
  private async keywordSearch(scope: IndexScope, query: string, k: number): Promise<ToolMatch[]> {
    return this.vectors
      .aggregate<ToolMatch>([
        {
          $search: {
            index: TEXT_INDEX.name,
            compound: {
              must: [{ text: { query, path: 'text' } }],
              filter: [
                { equals: { path: 'tenantId', value: scope.tenantId } },
                { equals: { path: 'specId', value: scope.specId } },
              ],
            },
          },
        },
        { $limit: k },
        { $project: { _id: 0, toolName: 1, text: 1, score: { $meta: 'searchScore' } } },
      ])
      .toArray();
  }

  /**
   * Waits until a just-written tool can be found by its own text. The vector index follows the
   * collection asynchronously, so a search right after `reindex` can miss new vectors (seen: the
   * first chat question after a fresh index found nothing). Pass the last tool written; when it
   * is searchable, the earlier writes are too.
   */
  async waitUntilSearchable(
    scope: IndexScope,
    tool: ToolDefinition,
    timeoutMs = 120_000,
  ): Promise<void> {
    await waitFor(
      async () =>
        (await this.search(scope, buildToolText(tool), 10)).some((m) => m.toolName === tool.name),
      `Tool ${tool.name}`,
      timeoutMs,
    );
  }
}
