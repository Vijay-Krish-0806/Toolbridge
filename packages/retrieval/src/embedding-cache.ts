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
