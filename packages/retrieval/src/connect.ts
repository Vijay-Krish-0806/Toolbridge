/**
 * Opens an index on its own MongoDB connection, for scripts and CLIs that have no app around
 * them (the chat CLI, evals). Apps with a connection already (the platform API) build the index
 * classes directly.
 */
import { type Db, MongoClient } from 'mongodb';

import type { EmbeddingConfig } from './config.js';
import type { EmbeddingProvider } from './embedding/provider.js';
import { OllamaEmbeddingProvider } from './embedding/ollama.js';
import { KnowledgeIndex } from './knowledge/knowledge-index.js';
import { ToolIndex } from './tool-index.js';

export interface ConnectOptions {
  mongoUri: string;
  dbName: string;
  embedding: EmbeddingConfig;
}

type Connected<T> = Promise<{ index: T; close: () => Promise<void> }>;

/**
 * Connects, makes sure the tool index exists, and returns it with a `close` function.
 * Before -> after: `({ mongoUri, dbName: 'toolbridge_agent', embedding })` ->
 * `{ index: ToolIndex, close: () => Promise<void> }`.
 */
export function connectToolIndex(options: ConnectOptions): Connected<ToolIndex> {
  return connectWith(options, (db, provider) => new ToolIndex(db, provider));
}

/** The same for the knowledge index (Step 3.3). */
export function connectKnowledgeIndex(options: ConnectOptions): Connected<KnowledgeIndex> {
  return connectWith(options, (db, provider) => new KnowledgeIndex(db, provider));
}

/** Connects, builds the index, runs `ensureIndexes`, and closes the client again if that fails. */
async function connectWith<T extends { ensureIndexes(): Promise<void> }>(
  options: ConnectOptions,
  build: (db: Db, provider: EmbeddingProvider) => T,
): Connected<T> {
  const client = await MongoClient.connect(options.mongoUri);
  try {
    const index = build(client.db(options.dbName), new OllamaEmbeddingProvider(options.embedding));
    await index.ensureIndexes();
    return { index, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
