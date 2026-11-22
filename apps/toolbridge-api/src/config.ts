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
   * Where this process runs (Step 4.4b). Only `development` turns on the dev login page, which
   * accepts a tenant API key in a browser form. The default is `production`, so forgetting to set
   * it can never switch the page on.
   */
  PLATFORM_ENV: z.enum(['development', 'test', 'production']).default('production'),
  /** Redis for the run queue (Step 4.4a). Local Docker publishes it on 127.0.0.1 only. */
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65_535).default(6379),
  /** Prefix of every queue key in Redis, so separate environments (and test runs) never mix. */
  RUN_QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .default('toolbridge'),
  /**
   * Longest one run leg may take (start to pause or end, or resume to the next pause or end).
   * Past it the leg is aborted and the run fails with "time limit" (Step 4.4a). Default 10 min.
   */
  RUN_LEG_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  /** Legs one worker process runs at the same time. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  /**
   * How long a worker's claim on a job lasts without renewal. A worker that dies stops renewing,
   * so another worker takes the job over after about this long (BullMQ default 30 s).
   */
  WORKER_LOCK_MS: z.coerce.number().int().min(500).default(30_000),
  /** Per tenant: runs that may start per minute (token bucket in Redis, Step 4.5). */
  RATE_RUNS_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Per tenant: tool calls per second across all its runs, protecting the tenant's API. */
  RATE_TOOL_CALLS_PER_SECOND: z.coerce.number().int().min(1).default(10),
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
  /**
   * Signs session tokens (Step 4.4b, HS256): base64 of exactly 32 random bytes, checked at
   * startup like the master key. Anyone who has it can mint tokens for any tenant, so it lives
   * only in the platform's environment. Changing it logs every user out.
   */
  PLATFORM_SESSION_KEY: masterKey,
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
