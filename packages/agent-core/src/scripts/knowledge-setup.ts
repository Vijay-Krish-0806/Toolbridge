/**
 * Step 3.3 wiring for scripts: ingests knowledge/host-store into a knowledge index (only changed
 * sections are embedded) and returns the knowledge_search tool on top of it. Shared by the chat
 * CLI and the knowledge eval, so both search exactly the same way.
 */
import { resolve } from 'node:path';

import {
  connectKnowledgeIndex,
  loadEmbeddingConfig,
  loadKnowledgeDir,
  type KnowledgeIndex,
  type KnowledgeScope,
} from '@toolbridge/retrieval';
import { z } from 'zod';

import { createKnowledgeTool } from '../tools/knowledge-tool.js';
import type { Tool } from '../tools/tool.js';

/** The local "tenant" and its one source of documents. */
export const KNOWLEDGE_SCOPE: KnowledgeScope = { tenantId: 'local', source: 'host-store' };
/** Passages per search: enough for a question that touches two sections, small enough to read. */
export const PASSAGES_PER_SEARCH = 4;

const KNOWLEDGE_DIR = resolve(import.meta.dirname, '../../../../knowledge/host-store');

/**
 * Connects, reindexes the policy folder, waits until new chunks are searchable, and builds the
 * tool. `close` ends the MongoDB connection.
 * Before -> after: `'toolbridge_agent'` -> `{ tool: knowledge_search, index, close }`, after
 * printing `knowledge index: {"total":24,"unchanged":24,...}`.
 */
export async function createKnowledge(dbName: string): Promise<{
  tool: Tool;
  index: KnowledgeIndex;
  close: () => Promise<void>;
}> {
  const { MONGO_URI } = z.object({ MONGO_URI: z.string().min(1) }).parse(process.env);
  const { index, close } = await connectKnowledgeIndex({
    mongoUri: MONGO_URI,
    dbName,
    embedding: loadEmbeddingConfig(),
  });
  try {
    const chunks = await loadKnowledgeDir(KNOWLEDGE_DIR);
    const summary = await index.reindex(KNOWLEDGE_SCOPE, chunks);
    const last = chunks.at(-1);
    if (last && summary.unchanged < summary.total) {
      await index.waitUntilSearchable(KNOWLEDGE_SCOPE, last);
    }
    console.log(`knowledge index: ${JSON.stringify(summary)}`);
    const tool = createKnowledgeTool({
      search: async (query) =>
        (await index.search(KNOWLEDGE_SCOPE, query, PASSAGES_PER_SEARCH)).map((m) => ({
          id: m.id,
          section: m.headingPath.join(' > '),
          text: m.text,
        })),
    });
    return { tool, index, close };
  } catch (error) {
    await close();
    throw error;
  }
}
