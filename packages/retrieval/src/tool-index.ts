/**
 * The tool index: one vector per tool, per tenant and spec, searchable with Atlas Vector Search.
 * Reindexing is incremental: each stored vector remembers the hash of the text it came from, so
 * only tools whose text changed are re-embedded, and the embedding cache catches texts we have
 * seen before (for example an edit that was reverted).
 *
 * Tenant isolation: every query and write here filters on tenantId. The vector index declares
 * tenantId and specId as filter fields, so the search itself is pre-filtered to one tenant's tools;
 * it never ranks another tenant's tools and drops them afterwards.
 */
import type { ToolDefinition } from '@toolbridge/spec-compiler';
import type { Collection, Db } from 'mongodb';

import { EmbeddingCache, embeddingKey, vectorsFor } from './embedding-cache.js';
import type { EmbeddingProvider } from './embedding/provider.js';
import { buildToolText } from './tool-text.js';
import { ensureVectorIndex, numCandidates, type VectorIndexSpec, waitFor } from './vector-index.js';

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
  /** Atlas Vector Search score, 0 to 1 (higher is closer). */
  score: number;
}

const VECTOR_INDEX: VectorIndexSpec = {
  name: 'tool_vectors_vector',
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
   * Creates the unique index and the vector search index if they are missing, then waits until the
   * vector index can be queried (details in ensureVectorIndex).
   */
  async ensureIndexes(timeoutMs = 60_000): Promise<void> {
    await this.vectors.createIndex(
      { tenantId: 1, specId: 1, toolName: 1 },
      { unique: true },
      undefined,
    );
    await ensureVectorIndex(this.vectors, VECTOR_INDEX, this.provider, timeoutMs);
  }

  /**
   * Brings one spec's vectors in line with its current tools.
   * Before -> after: 35 indexed tools, one description edited ->
   * `{ total: 35, unchanged: 34, fromCache: 0, embedded: 1, removed: 0 }`.
   */
  async reindex(scope: IndexScope, tools: ToolDefinition[]): Promise<ReindexSummary> {
    const stored = await this.vectors
      .find(scope, { projection: { _id: 0, toolName: 1, textHash: 1 } })
      .toArray();
    const storedHash = new Map(stored.map((v) => [v.toolName, v.textHash]));

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
        changed.map(({ tool, key }) => ({
          updateOne: {
            filter: { ...scope, toolName: tool.name },
            update: {
              $set: {
                textHash: key,
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
   * The k tools of one spec closest to a query, best first. Approximate (HNSW) search over
   * 20 x k candidates, the ratio the Atlas docs recommend. Step 3.2 builds tool selection on this.
   * The index is eventually consistent: a vector written a moment ago may not be found yet.
   * Before -> after: `'refund a damaged order', 3` ->
   * `[{ toolName: 'refunds_request', score: 0.8 }, ...]` (scores illustrative).
   */
  async search(scope: IndexScope, query: string, k: number): Promise<ToolMatch[]> {
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
        { $project: { _id: 0, toolName: 1, score: { $meta: 'vectorSearchScore' } } },
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
