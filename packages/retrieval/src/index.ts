export type { EmbeddingProvider } from './embedding/provider.js';
export { OllamaEmbeddingProvider, type OllamaEmbeddingOptions } from './embedding/ollama.js';
export { loadEmbeddingConfig, type EmbeddingConfig } from './config.js';
export { buildToolText } from './tool-text.js';
export { EmbeddingCache, embeddingKey } from './embedding-cache.js';
export { ToolIndex, type IndexScope, type ReindexSummary, type ToolMatch } from './tool-index.js';
