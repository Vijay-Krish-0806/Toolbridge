import { z } from 'zod';

const envSchema = z.object({
  /** Any OpenAI-compatible server. Ollama serves one at /v1. */
  LLM_BASE_URL: z.url().default('http://127.0.0.1:11434/v1'),
  /** The Modelfile variant with a 16K context (see infra/ollama/). */
  LLM_MODEL: z.string().min(1).default('toolbridge-qwen3.5-4b-16k'),
  /** Ollama ignores the key, but the OpenAI client requires a value. */
  LLM_API_KEY: z.string().min(1).default('ollama'),
  /**
   * The context window the server was configured with. The OpenAI API cannot set it per request,
   * so this must match the model's num_ctx. Code uses it as a token budget, not to configure the model.
   */
  LLM_CONTEXT_LENGTH: z.coerce.number().int().min(2048).default(16_384),
});

export interface LLMConfig {
  baseURL: string;
  model: string;
  apiKey: string;
  contextLength: number;
}

/** Validates the LLM settings once at startup, so a bad config fails fast with a clear message. */
export function loadLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid LLM configuration:\n${z.prettifyError(result.error)}`);
  }
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, LLM_CONTEXT_LENGTH } = result.data;
  return {
    baseURL: LLM_BASE_URL,
    model: LLM_MODEL,
    apiKey: LLM_API_KEY,
    contextLength: LLM_CONTEXT_LENGTH,
  };
}

const hostApiEnvSchema = z.object({
  /** The host store API that the hand-written tools call. */
  HOST_API_URL: z.url().default('http://127.0.0.1:3000'),
  /** The staff account the tools act as. Its role decides what the agent may do (403 otherwise). */
  HOST_API_EMAIL: z.email().default('support@store.example'),
  /** No default: credentials must be set explicitly. */
  HOST_API_PASSWORD: z.string().min(1),
});

export interface HostApiConfig {
  baseUrl: string;
  email: string;
  password: string;
}

/** Validates the host API settings once at startup, like loadLLMConfig. */
export function loadHostApiConfig(env: NodeJS.ProcessEnv = process.env): HostApiConfig {
  const result = hostApiEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid host API configuration:\n${z.prettifyError(result.error)}`);
  }
  const { HOST_API_URL, HOST_API_EMAIL, HOST_API_PASSWORD } = result.data;
  return { baseUrl: HOST_API_URL, email: HOST_API_EMAIL, password: HOST_API_PASSWORD };
}
