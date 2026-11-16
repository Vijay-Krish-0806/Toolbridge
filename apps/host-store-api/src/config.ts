import { z } from 'zod';

const envSchema = z.object({
  MONGO_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  MONGO_DB: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
