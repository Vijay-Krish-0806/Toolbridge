import { type LLMConfig, loadLLMConfig } from '@toolbridge/agent-core';
import { type EmbeddingConfig, loadEmbeddingConfig } from '@toolbridge/retrieval';
import { z } from 'zod';

/** The placeholder in .env.example; refused so a copied example never runs as a real key. */
export const EXAMPLE_ADMIN_KEY = 'change-me-to-a-long-random-string-of-at-least-32-chars';

/** Comma-separated host names -> trimmed, lower-case list; empty string -> []. */
const hostList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ''),
  );

/** base64 of exactly 32 bytes -> the key bytes; anything else -> undefined. */
function decodeMasterKey(encoded: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return undefined;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 ? key : undefined;
}

/** A master key from the environment: must decode to exactly 32 bytes. Never echoed in errors. */
const masterKey = z.string().transform((value, ctx) => {
  const key = decodeMasterKey(value);
  if (!key) {
    ctx.addIssue({ code: 'custom', message: 'must be base64 of exactly 32 bytes' });
    return z.NEVER;
  }
  return key;
});

const envSchema = z.object({
  MONGO_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  /** The platform's own database, separate from the host app's. */
  PLATFORM_MONGO_DB: z.string().min(1).default('toolbridge'),
  PLATFORM_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  /**
   * Creates tenants. Compared in constant time. At least 32 characters, and never the example
   * value, so a weak or copied key fails at startup instead of in production.
   */
  PLATFORM_ADMIN_KEY: z
    .string()
    .min(32, 'must be at least 32 characters')
    .refine((key) => key !== EXAMPLE_ADMIN_KEY, 'is still the example value; generate a new one'),
  /**
   * Host names that may resolve to private addresses when fetching a spec by URL (for example
   * "localhost" in development). Platform configuration only: tenants can never set it.
   */
  PLATFORM_ALLOW_PRIVATE_HOSTS: hostList,
  /** Largest spec accepted, by upload or by URL. Default 10 MiB. */
  MAX_SPEC_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  MAX_SPECS_PER_TENANT: z.coerce.number().int().min(1).default(20),
  /** How long fetching a spec by URL may take. */
  SPEC_FETCH_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  /**
   * The master key (KEK) that wraps every data key: base64 of exactly 32 random bytes
   * (AES-256). Checked at startup, so a short or malformed key never reaches encryption.
   */
  PLATFORM_MASTER_KEY: masterKey,
  /** Label stored beside every wrapped data key, so rotation knows which master key wrapped it. */
  PLATFORM_MASTER_KEY_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, _ or -, at most 32')
    .default('v1'),
  /**
   * Older master keys still needed to unwrap data keys during a rotation:
   * "v1=<base64>,v0=<base64>". Remove an entry once nothing is wrapped with it any more.
   */
  PLATFORM_PREVIOUS_MASTER_KEYS: z
    .string()
    .default('')
    .transform((value, ctx) => {
      const keys: Record<string, Buffer> = {};
      for (const entry of value
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '')) {
        const [version, encoded] = entry.split('=', 2);
        const key = decodeMasterKey(encoded ?? '');
        if (!version || !key) {
          ctx.addIssue({ code: 'custom', message: `invalid entry "${version ?? ''}=…"` });
          return z.NEVER;
        }
        keys[version] = key;
      }
      return keys;
    }),
});

export type PlatformConfig = z.infer<typeof envSchema> & {
  /** The tool index's embedding model (EMBEDDING_* variables, validated by the retrieval package). */
  embedding: EmbeddingConfig;
  /** The model agent runs use (LLM_* variables, validated by agent-core). */
  llm: LLMConfig;
};

/** Validates environment variables once at startup, so a bad config fails fast with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid platform configuration:\n${z.prettifyError(result.error)}`);
  }
  return {
    ...result.data,
    embedding: loadEmbeddingConfig(env),
    llm: loadLLMConfig(env),
  };
}
