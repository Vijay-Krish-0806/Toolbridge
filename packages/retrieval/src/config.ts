import { z } from 'zod';

const envSchema = z.object({
  /** Ollama's root URL (the native API, not /v1). */
  EMBEDDING_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  EMBEDDING_MODEL: z.string().min(1).default('qwen3-embedding:0.6b'),
  /** Must match the vector index. 1024 is qwen3-embedding:0.6b's native size (measured). */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(32).max(8192).default(1024),
  /** Task instruction for queries (Qwen3-Embedding format). Empty: no instruction. */
  EMBEDDING_QUERY_INSTRUCTION: z
    .string()
    .default('Given a user request, retrieve the API tools that can fulfil it'),
});

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  dimensions: number;
  queryInstruction: string;
}

/** Validates the embedding settings once at startup, like loadLLMConfig in agent-core. */
export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid embedding configuration:\n${z.prettifyError(result.error)}`);
  }
  const d = result.data;
  return {
    baseUrl: d.EMBEDDING_BASE_URL,
    model: d.EMBEDDING_MODEL,
    dimensions: d.EMBEDDING_DIMENSIONS,
    queryInstruction: d.EMBEDDING_QUERY_INSTRUCTION,
  };
}
