/**
 * Opens a tool index on its own MongoDB connection, for scripts and CLIs that have no app around
 * them (the chat CLI). Apps with a connection already (the platform API) build ToolIndex directly.
 */
import { MongoClient } from 'mongodb';

import type { EmbeddingConfig } from './config.js';
import { OllamaEmbeddingProvider } from './embedding/ollama.js';
import { ToolIndex } from './tool-index.js';

/**
 * Connects, makes sure the indexes exist, and returns the index with a `close` function.
 * Before -> after: `({ mongoUri, dbName: 'toolbridge_agent', embedding })` ->
 * `{ index: ToolIndex, close: () => Promise<void> }`.
 */
export async function connectToolIndex(options: {
  mongoUri: string;
  dbName: string;
  embedding: EmbeddingConfig;
}): Promise<{ index: ToolIndex; close: () => Promise<void> }> {
  const client = await MongoClient.connect(options.mongoUri);
  try {
    const index = new ToolIndex(
      client.db(options.dbName),
      new OllamaEmbeddingProvider(options.embedding),
    );
    await index.ensureIndexes();
    return { index, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
