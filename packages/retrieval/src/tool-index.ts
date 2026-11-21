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

import { EmbeddingCache, embeddingKey } from './embedding-cache.js';
import type { EmbeddingProvider } from './embedding/provider.js';
import { buildToolText } from './tool-text.js';

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

/**
 * The fields we read from `listSearchIndexes`. The driver (7.8.0) types its rows as `{ name }`
 * only; the server also returns these (seen on Atlas Local 8.0).
 */
interface ListedSearchIndex {
  name: string;
  /** For example PENDING, BUILDING, READY, FAILED, DELETING, DOES_NOT_EXIST. */
  status?: string;
  queryable?: boolean;
  latestDefinition?: { fields?: { type?: string; numDimensions?: number }[] };
}

const VECTOR_INDEX = 'tool_vectors_vector';
/** Statuses of an index that is going away, not one we can use. */
const LEFTOVER_STATUSES = new Set(['DELETING', 'DOES_NOT_EXIST']);
/** Atlas Vector Search allows at most 10,000 candidates. */
const MAX_CANDIDATES = 10_000;

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
   * vector index can be queried (about a second on Atlas Local). An existing vector index built for
   * a different vector size is an error: it cannot hold this provider's vectors.
   * Right after its collection is dropped, the old index is still listed for a moment with status
   * DOES_NOT_EXIST (seen on Atlas Local 8.0). That entry counts as missing: wait for it to go away,
   * then create the new index. Treating it as existing would wait forever for an index that is gone.
   */
  async ensureIndexes(timeoutMs = 60_000): Promise<void> {
    await this.vectors.createIndex(
      { tenantId: 1, specId: 1, toolName: 1 },
      { unique: true },
      undefined,
    );
    const deadline = Date.now() + timeoutMs;
    let created = false;
    for (;;) {
      const [index] = await this.listVectorIndex();
      if (index === undefined) {
        if (!created) await this.createVectorIndex();
        created = true;
      } else if (index.status === 'FAILED') {
        throw new Error(`Vector index ${VECTOR_INDEX} failed to build.`);
      } else if (!LEFTOVER_STATUSES.has(index.status ?? '')) {
        this.checkDimensions(index);
        if (index.queryable === true) return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Vector index ${VECTOR_INDEX} is not queryable after ${String(timeoutMs)} ms (status ${index?.status ?? 'none'}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
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

    const cached = await this.cache.getMany(changed.map((c) => c.key));
    const missing = changed.filter((c) => !cached.has(c.key));
    const fresh = await this.provider.embed(missing.map((c) => c.text));
    const freshEntries = missing.map((c, i) => ({ key: c.key, vector: fresh[i] ?? [] }));
    await this.cache.setMany(this.provider, freshEntries);
    const vectorOf = new Map([...cached, ...freshEntries.map((e) => [e.key, e.vector] as const)]);

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
      fromCache: changed.length - missing.length,
      embedded: missing.length,
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
    const [queryVector] = await this.provider.embed([query]);
    return this.vectors
      .aggregate<ToolMatch>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: 'vector',
            queryVector,
            numCandidates: Math.min(Math.max(k * 20, 100), MAX_CANDIDATES),
            limit: k,
            filter: { tenantId: scope.tenantId, specId: scope.specId },
          },
        },
        { $project: { _id: 0, toolName: 1, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
  }

  /** Our vector index as listed by the server (an empty array when it does not exist). */
  private async listVectorIndex(): Promise<ListedSearchIndex[]> {
    return this.vectors.listSearchIndexes(VECTOR_INDEX).toArray();
  }

  /** Starts building the vector search index (asynchronous on the server). */
  private async createVectorIndex(): Promise<void> {
    await this.vectors.createSearchIndex({
      name: VECTOR_INDEX,
      type: 'vectorSearch',
      definition: {
        fields: [
          // The vectors are unit length (measured), so cosine and dotProduct rank the same.
          {
            type: 'vector',
            path: 'vector',
            numDimensions: this.provider.dimensions,
            similarity: 'cosine',
          },
          { type: 'filter', path: 'tenantId' },
          { type: 'filter', path: 'specId' },
        ],
      },
    });
  }

  /** Throws when the index was built for a different vector size than this provider's. */
  private checkDimensions(index: ListedSearchIndex): void {
    const dims = index.latestDefinition?.fields?.find((f) => f.type === 'vector')?.numDimensions;
    if (dims !== this.provider.dimensions) {
      throw new Error(
        `Vector index ${VECTOR_INDEX} is built for ${String(dims)} dimensions, but ${this.provider.model} ` +
          `is configured for ${String(this.provider.dimensions)}. Drop the index and reindex.`,
      );
    }
  }
}
