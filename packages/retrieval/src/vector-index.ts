/**
 * Helpers shared by every index in this package (tools in Step 3.1, knowledge chunks in Step 3.3):
 * create an Atlas Vector Search or Atlas Search (keyword) index and wait until it can be queried,
 * and size the candidate pool of a search. Extracted so the subtle parts (leftover indexes after a drop,
 * dimension checks) live in one place.
 */
import type { Collection, Document } from 'mongodb';

import type { EmbeddingProvider } from './embedding/provider.js';

export interface VectorIndexSpec {
  /** The search index name, for example `tool_vectors_vector`. */
  name: string;
  /** Fields a search can pre-filter on (tenant isolation needs `tenantId` here). */
  filterPaths: string[];
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

/** Statuses of an index that is going away, not one we can use. */
const LEFTOVER_STATUSES = new Set(['DELETING', 'DOES_NOT_EXIST']);
/** Atlas Vector Search allows at most 10,000 candidates. */
const MAX_CANDIDATES = 10_000;

/**
 * Candidates for an approximate (HNSW) search: 20 x k, the ratio the Atlas docs recommend, at
 * least 100 and at most the 10,000 Atlas allows.
 * Before -> after: `5` -> `100`; `20` -> `400`.
 */
export function numCandidates(k: number): number {
  return Math.min(Math.max(k * 20, 100), MAX_CANDIDATES);
}

/**
 * Creates the vector search index if it is missing, then waits until it can be queried (about a
 * second on Atlas Local). An existing index built for a different vector size is an error: it
 * cannot hold this provider's vectors.
 * Before -> after: a collection with no search index -> the same collection with a queryable
 * `spec.name` index (vector field `vector`, cosine, `provider.dimensions` long).
 */
export async function ensureVectorIndex<T extends Document>(
  collection: Collection<T>,
  spec: VectorIndexSpec,
  provider: EmbeddingProvider,
  timeoutMs = 60_000,
): Promise<void> {
  await ensureSearchIndex(
    collection,
    spec.name,
    () => createVectorIndex(collection, spec, provider),
    (index) => {
      checkDimensions(index, spec, provider);
    },
    timeoutMs,
  );
}

/**
 * Step 3.4: the keyword (BM25) side of hybrid search. Creates an Atlas Search index with the given
 * string fields (English analyzer, so "chargebacks" matches "chargeback") and the filter fields as
 * `token`, the type the `equals` operator needs, then waits until it can be queried.
 * Before -> after: `{ name: 'tool_vectors_text', textPaths: ['text'], filterPaths: ['tenantId'] }`
 * -> a queryable search index on those fields.
 */
export async function ensureTextIndex<T extends Document>(
  collection: Collection<T>,
  spec: { name: string; textPaths: string[]; filterPaths: string[] },
  timeoutMs = 60_000,
): Promise<void> {
  const fields: Record<string, { type: string; analyzer?: string }> = {};
  for (const path of spec.textPaths) fields[path] = { type: 'string', analyzer: 'lucene.english' };
  for (const path of spec.filterPaths) fields[path] = { type: 'token' };
  await ensureSearchIndex(
    collection,
    spec.name,
    async () => {
      await collection.createSearchIndex({
        name: spec.name,
        type: 'search',
        definition: { mappings: { dynamic: false, fields } },
      });
    },
    () => undefined,
    timeoutMs,
  );
}

/**
 * The polling loop both index kinds share: create the index once if it is missing, fail on FAILED,
 * and return when it is queryable.
 * Right after its collection is dropped, the old index is still listed for a moment with status
 * DOES_NOT_EXIST (seen on Atlas Local 8.0). That entry counts as missing: wait for it to go away,
 * then create the new index. Treating it as existing would wait forever for an index that is gone.
 */
async function ensureSearchIndex<T extends Document>(
  collection: Collection<T>,
  name: string,
  create: () => Promise<void>,
  check: (index: ListedSearchIndex) => void,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let created = false;
  for (;;) {
    const [index] = (await collection.listSearchIndexes(name).toArray()) as ListedSearchIndex[];
    if (index === undefined) {
      if (!created) await create();
      created = true;
    } else if (index.status === 'FAILED') {
      throw new Error(`Search index ${name} failed to build.`);
    } else if (!LEFTOVER_STATUSES.has(index.status ?? '')) {
      check(index);
      if (index.queryable === true) return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Search index ${name} is not queryable after ${String(timeoutMs)} ms (status ${index?.status ?? 'none'}).`,
      );
    }
    await sleep(500);
  }
}

/**
 * Polls `found` every half second until it returns true. Used after writes, because the vector
 * index follows the collection asynchronously: a search right after a write can miss it.
 */
export async function waitFor(
  found: () => Promise<boolean>,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await found()) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} is not searchable after ${String(timeoutMs)} ms.`);
    }
    await sleep(500);
  }
}

/** Starts building the vector search index (asynchronous on the server). */
async function createVectorIndex<T extends Document>(
  collection: Collection<T>,
  spec: VectorIndexSpec,
  provider: EmbeddingProvider,
): Promise<void> {
  await collection.createSearchIndex({
    name: spec.name,
    type: 'vectorSearch',
    definition: {
      fields: [
        // The vectors are unit length (measured), so cosine and dotProduct rank the same.
        {
          type: 'vector',
          path: 'vector',
          numDimensions: provider.dimensions,
          similarity: 'cosine',
        },
        ...spec.filterPaths.map((path) => ({ type: 'filter', path })),
      ],
    },
  });
}

/** Throws when the index was built for a different vector size than this provider's. */
function checkDimensions(
  index: ListedSearchIndex,
  spec: VectorIndexSpec,
  provider: EmbeddingProvider,
): void {
  const dims = index.latestDefinition?.fields?.find((f) => f.type === 'vector')?.numDimensions;
  if (dims !== provider.dimensions) {
    throw new Error(
      `Vector index ${spec.name} is built for ${String(dims)} dimensions, but ${provider.model} ` +
        `is configured for ${String(provider.dimensions)}. Drop the index and reindex.`,
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
