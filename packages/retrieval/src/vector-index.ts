/**
 * Helpers shared by every vector index in this package (tools in Step 3.1, knowledge chunks in
 * Step 3.3): create an Atlas Vector Search index and wait until it can be queried, and size the
 * candidate pool of a search. Extracted so the subtle parts (leftover indexes after a drop,
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
 * Right after its collection is dropped, the old index is still listed for a moment with status
 * DOES_NOT_EXIST (seen on Atlas Local 8.0). That entry counts as missing: wait for it to go away,
 * then create the new index. Treating it as existing would wait forever for an index that is gone.
 * Before -> after: a collection with no search index -> the same collection with a queryable
 * `spec.name` index (vector field `vector`, cosine, `provider.dimensions` long).
 */
export async function ensureVectorIndex<T extends Document>(
  collection: Collection<T>,
  spec: VectorIndexSpec,
  provider: EmbeddingProvider,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let created = false;
  for (;;) {
    const [index] = (await collection
      .listSearchIndexes(spec.name)
      .toArray()) as ListedSearchIndex[];
    if (index === undefined) {
      if (!created) await createVectorIndex(collection, spec, provider);
      created = true;
    } else if (index.status === 'FAILED') {
      throw new Error(`Vector index ${spec.name} failed to build.`);
    } else if (!LEFTOVER_STATUSES.has(index.status ?? '')) {
      checkDimensions(index, spec, provider);
      if (index.queryable === true) return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Vector index ${spec.name} is not queryable after ${String(timeoutMs)} ms (status ${index?.status ?? 'none'}).`,
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
