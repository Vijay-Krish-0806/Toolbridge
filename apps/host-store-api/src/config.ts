import { z } from 'zod';

const envSchema = z.object({
  MONGO_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  MONGO_DB: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Password given to the seeded staff users. Development only. */
  SEED_STAFF_PASSWORD: z.string().min(8),
  /** Freezes the API's "now" (ISO date). Set it to the seed's reference date for seeded data. */
  HOST_CLOCK_NOW: z.iso.datetime().optional(),
});

export type HostConfig = z.infer<typeof envSchema>;

/** Validates environment variables once at startup, so a bad config fails fast with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
