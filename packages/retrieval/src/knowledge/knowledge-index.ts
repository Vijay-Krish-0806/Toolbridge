/**
 * Step 3.3: the knowledge index. One vector per policy chunk, per tenant and source (a folder or
 * upload of documents), searchable with Atlas Vector Search. Same design as the tool index:
 * incremental reindex by text hash, the shared embedding cache, and a tenant pre-filter.
 * The chunk's text and metadata are stored next to its vector, so a search returns everything
 * needed to show and cite a passage in one query.
 */
import type { Collection, Db } from 'mongodb';

import { EmbeddingCache, embeddingKey, vectorsFor } from '../embedding-cache.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { ReindexSummary } from '../tool-index.js';
import {
  ensureVectorIndex,
  numCandidates,
  type VectorIndexSpec,
  waitFor,
} from '../vector-index.js';
import { buildChunkText, type KnowledgeChunk } from './chunker.js';

/** Which documents: one source of one tenant. */
export interface KnowledgeScope {
  tenantId: string;
  source: string;
}

interface StoredChunk {
  tenantId: string;
  source: string;
  chunkId: string;
  docId: string;
  title: string;
  headingPath: string[];
  text: string;
  textHash: string;
  vector: number[];
  updatedAt: Date;
}

export interface KnowledgeMatch {
  /** The citation id, for example `refund-policy#damaged-items`. */
  id: string;
  docId: string;
  title: string;
  headingPath: string[];
  text: string;
  /** Atlas Vector Search score, 0 to 1 (higher is closer). */
  score: number;
}

/**
 * Task instruction for policy searches (Qwen3-Embedding format). Different from the tool index's:
 * here the query should find a passage that answers it, not an API that can act on it.
 */
export const KNOWLEDGE_QUERY_INSTRUCTION =
  'Given a question from store staff, retrieve the policy passages that answer it';

const VECTOR_INDEX: VectorIndexSpec = {
  name: 'knowledge_chunks_vector',
  filterPaths: ['tenantId', 'source'],
};

export class KnowledgeIndex {
  private readonly chunks: Collection<StoredChunk>;
  private readonly cache: EmbeddingCache;

  /** Uses the `knowledge_chunks` and `embeddings` collections of the given database. */
  constructor(
    db: Db,
    private readonly provider: EmbeddingProvider,
    private readonly queryInstruction = KNOWLEDGE_QUERY_INSTRUCTION,
  ) {
    this.chunks = db.collection<StoredChunk>('knowledge_chunks');
    this.cache = new EmbeddingCache(db);
  }

  /** Creates the unique index and the vector search index if missing, and waits until queryable. */
  async ensureIndexes(timeoutMs = 60_000): Promise<void> {
    await this.chunks.createIndex(
      { tenantId: 1, source: 1, chunkId: 1 },
      { unique: true },
      undefined,
    );
    await ensureVectorIndex(this.chunks, VECTOR_INDEX, this.provider, timeoutMs);
  }

  /**
   * Brings one source's stored chunks in line with its current chunks: changed or new chunks are
   * re-embedded (or taken from the cache), chunks that are gone are deleted.
   * Before -> after: 26 indexed chunks, one section edited ->
   * `{ total: 26, unchanged: 25, fromCache: 0, embedded: 1, removed: 0 }`.
   */
  async reindex(scope: KnowledgeScope, chunks: KnowledgeChunk[]): Promise<ReindexSummary> {
    const stored = await this.chunks
      .find(scope, { projection: { _id: 0, chunkId: 1, textHash: 1 } })
      .toArray();
    const storedHash = new Map(stored.map((c) => [c.chunkId, c.textHash]));

    const changed = chunks
      .map((chunk) => {
        const text = buildChunkText(chunk);
        return { chunk, text, key: embeddingKey(this.provider, text) };
      })
      .filter(({ chunk, key }) => storedHash.get(chunk.id) !== key);
    const { vectorOf, embedded } = await vectorsFor(this.cache, this.provider, changed);

    const updatedAt = new Date();
    if (changed.length > 0) {
      await this.chunks.bulkWrite(
        changed.map(({ chunk, key }) => ({
          updateOne: {
            filter: { ...scope, chunkId: chunk.id },
            update: {
              $set: {
                docId: chunk.docId,
                title: chunk.title,
                headingPath: chunk.headingPath,
                text: chunk.text,
                textHash: key,
                vector: vectorOf.get(key) ?? [],
                updatedAt,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    const { deletedCount } = await this.chunks.deleteMany({
      ...scope,
      chunkId: { $nin: chunks.map((c) => c.id) },
    });

    return {
      total: chunks.length,
      unchanged: chunks.length - changed.length,
      fromCache: changed.length - embedded,
      embedded,
      removed: deletedCount,
    };
  }

  /**
   * The k chunks of one source closest to a question, best first, with their text and metadata.
   * Before -> after: `'can a customer return a mug they did not like?', 3` ->
   * `[{ id: 'refund-policy#changed-their-mind', text: 'Use the reason ...', score: 0.86 }, ...]`
   * (scores illustrative).
   */
  async search(scope: KnowledgeScope, query: string, k: number): Promise<KnowledgeMatch[]> {
    const queryVector = await this.provider.embedQuery(query, this.queryInstruction);
    return this.chunks
      .aggregate<KnowledgeMatch>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX.name,
            path: 'vector',
            queryVector,
            numCandidates: numCandidates(k),
            limit: k,
            filter: { tenantId: scope.tenantId, source: scope.source },
          },
        },
        {
          $project: {
            _id: 0,
            id: '$chunkId',
            docId: 1,
            title: 1,
            headingPath: 1,
            text: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ])
      .toArray();
  }

  /**
   * Waits until a just-written chunk can be found by its own text (the index is eventually
   * consistent). Pass the last chunk written.
   */
  async waitUntilSearchable(
    scope: KnowledgeScope,
    chunk: KnowledgeChunk,
    timeoutMs = 120_000,
  ): Promise<void> {
    await waitFor(
      async () =>
        (await this.search(scope, buildChunkText(chunk), 10)).some((m) => m.id === chunk.id),
      `Chunk ${chunk.id}`,
      timeoutMs,
    );
  }
}
