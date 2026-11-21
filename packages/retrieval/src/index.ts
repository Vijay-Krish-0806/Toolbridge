export type { EmbeddingProvider } from './embedding/provider.js';
export { OllamaEmbeddingProvider, type OllamaEmbeddingOptions } from './embedding/ollama.js';
export { loadEmbeddingConfig, type EmbeddingConfig } from './config.js';
export { buildToolText } from './tool-text.js';
export { EmbeddingCache, embeddingKey } from './embedding-cache.js';
export { ToolIndex, type IndexScope, type ReindexSummary, type ToolMatch } from './tool-index.js';
export { connectKnowledgeIndex, connectToolIndex, type ConnectOptions } from './connect.js';
export { buildChunkText, chunkMarkdown, type KnowledgeChunk } from './knowledge/chunker.js';
export { loadKnowledgeDir } from './knowledge/load.js';
export {
  KNOWLEDGE_QUERY_INSTRUCTION,
  KnowledgeIndex,
  type KnowledgeMatch,
  type KnowledgeScope,
} from './knowledge/knowledge-index.js';
export {
  DEFAULT_SELECTOR,
  VectorToolSelector,
  selectFromMatches,
  type SelectorOptions,
  type VectorToolSelection,
} from './tool-selector.js';
