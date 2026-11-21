import { z } from 'zod';

const envSchema = z.object({
  /** Ollama's root URL (the native API, not /v1). */
  EMBEDDING_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  EMBEDDING_MODEL: z.string().min(1).default('qwen3-embedding:0.6b'),
  /** Must match the vector index. 1024 is qwen3-embedding:0.6b's native size (measured). */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(32).max(8192).default(1024),
});

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  dimensions: number;
}

/** Validates the embedding settings once at startup, like loadLLMConfig in agent-core. */
export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid embedding configuration:\n${z.prettifyError(result.error)}`);
  }
  const { EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = result.data;
  return { baseUrl: EMBEDDING_BASE_URL, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
}
