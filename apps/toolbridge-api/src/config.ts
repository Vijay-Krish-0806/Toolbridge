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
});

export type PlatformConfig = z.infer<typeof envSchema>;

/** Validates environment variables once at startup, so a bad config fails fast with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid platform configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
