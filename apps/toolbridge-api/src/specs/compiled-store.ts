/**
 * The Step 2.4 compile cache, stored in MongoDB (the "database adapter" ADR 0017 promised).
 * Content-addressed, so entries are shared across tenants safely: a key is a hash of the content,
 * and the API never lets anyone read an entry by key, only through their own spec versions.
 * Entries are gzip-compressed: a compiled large spec can exceed MongoDB's 16 MB document limit as
 * plain JSON. Spec versions point at these entries, so they are kept, not evicted.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

import type { CompileCache, CompiledSpec } from '@toolbridge/spec-compiler';
import { type Connection, mongo } from 'mongoose';

interface StoredEntry {
  _id: string;
  /** Stored as BSON Binary; the driver returns it as mongo.Binary, not a Node Buffer. */
  gz: mongo.Binary;
  bytes: number;
  createdAt: Date;
}

/** MongoDB's hard limit for one document, minus some room for the other fields. */
const MAX_STORED_BYTES = 15 * 1024 * 1024;

export class MongoCompiledStore implements CompileCache {
  /** Uses the `compiled_specs` collection of the given connection. */
  constructor(private readonly connection: Connection) {}

  /** The compiled spec for a key, or undefined. */
  async get(key: string): Promise<CompiledSpec | undefined> {
    const entry = await this.collection().findOne({ _id: key });
    if (!entry) return undefined;
    return JSON.parse(gunzipSync(entry.gz.value()).toString('utf8')) as CompiledSpec;
  }

  /**
   * Stores an entry once. A second writer with the same key writes the same content, so an
   * existing entry is simply kept (upsert with $setOnInsert).
   */
  async set(key: string, value: CompiledSpec): Promise<void> {
    const json = JSON.stringify(value);
    const gz = gzipSync(json);
    if (gz.length > MAX_STORED_BYTES) {
      throw new Error(`Compiled spec is too large to store (${String(gz.length)} bytes compressed).`);
    }
    await this.collection().updateOne(
      { _id: key },
      { $setOnInsert: { gz: new mongo.Binary(gz), bytes: json.length, createdAt: new Date() } },
      { upsert: true },
    );
  }

  /** The raw collection (no Mongoose model: entries are opaque blobs). */
  private collection() {
    return this.connection.collection<StoredEntry>('compiled_specs');
  }
}
