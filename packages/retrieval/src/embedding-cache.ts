/**
 * Content-addressed embedding cache (the Step 2.4 pattern again). The key is a hash of everything
 * that decides the vector: model, dimensions and text. Same key -> same vector, so a vector is
 * never computed twice, across specs, versions and tenants. Sharing across tenants is safe for
 * the same reason as the compile cache: nobody can read an entry without already having its text.
 */
import { sha256 } from '@toolbridge/spec-compiler';
import type { Collection, Db } from 'mongodb';

import type { EmbeddingProvider } from './embedding/provider.js';

interface CachedEmbedding {
  _id: string;
  model: string;
  dimensions: number;
  vector: number[];
  createdAt: Date;
}

/**
 * The cache key for one text under one provider.
 * Before -> after: `('qwen3-embedding:0.6b', 1024, 'Tool: orders get ...')` -> 64 hex characters.
 */
export function embeddingKey(provider: EmbeddingProvider, text: string): string {
  return sha256(`${provider.model}\n${String(provider.dimensions)}\n${text}`);
}

/**
 * Vectors for these texts: from the cache where possible, the rest embedded by the model and
 * cached for next time. Shared by every index's incremental reindex.
 * Before -> after: 3 texts, 1 of them cached -> `{ vectorOf: Map(3 keys), embedded: 2 }`.
 */
export async function vectorsFor(
  cache: EmbeddingCache,
  provider: EmbeddingProvider,
  items: { key: string; text: string }[],
): Promise<{ vectorOf: Map<string, number[]>; embedded: number }> {
  const cached = await cache.getMany(items.map((item) => item.key));
  const missing = items.filter((item) => !cached.has(item.key));
  const fresh = await provider.embed(missing.map((item) => item.text));
  const freshEntries = missing.map((item, i) => ({ key: item.key, vector: fresh[i] ?? [] }));
  await cache.setMany(provider, freshEntries);
  for (const entry of freshEntries) cached.set(entry.key, entry.vector);
  return { vectorOf: cached, embedded: missing.length };
}

export class EmbeddingCache {
  private readonly collection: Collection<CachedEmbedding>;

  /** Uses the `embeddings` collection of the given database. */
  constructor(db: Db) {
    this.collection = db.collection<CachedEmbedding>('embeddings');
  }

  /** The cached vectors for these keys; keys with no entry are simply absent from the map. */
  async getMany(keys: string[]): Promise<Map<string, number[]>> {
    if (keys.length === 0) return new Map();
    const found = await this.collection.find({ _id: { $in: keys } }).toArray();
    return new Map(found.map((entry) => [entry._id, entry.vector]));
  }

  /** Stores new entries. An existing key holds the same vector, so it is kept ($setOnInsert). */
  async setMany(
    provider: EmbeddingProvider,
    entries: { key: string; vector: number[] }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const createdAt = new Date();
    await this.collection.bulkWrite(
      entries.map(({ key, vector }) => ({
        updateOne: {
          filter: { _id: key },
          update: {
            $setOnInsert: {
              model: provider.model,
              dimensions: provider.dimensions,
              vector,
              createdAt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
}
