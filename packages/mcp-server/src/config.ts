/**
 * MCP server settings, validated once at startup so a bad config fails fast with a clear message.
 * Relative paths are resolved against the repo root, so the server works from any working
 * directory (an MCP host such as Claude Code may start it from anywhere).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadHostApiConfig, type HostApiConfig } from '@toolbridge/agent-core';
import { z } from 'zod';

/** packages/mcp-server/dist -> repo root. */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Loads the repo's .env (if present) into process.env. Variables already set win, as with
 * `node --env-file`. An MCP host such as Claude Code starts the server by itself, without our
 * package scripts, so the server finds its own settings instead of relying on the host.
 */
export function loadRepoEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const envSchema = z.object({
  /** The OpenAPI spec to serve (file path or URL). */
  TOOLBRIDGE_SPEC: z.string().min(1).default('specs/host-store.json'),
  /** The overrides file for that spec. */
  TOOLBRIDGE_OVERRIDES: z.string().min(1).default('specs/host-store.overrides.json'),
  /** Where compiled specs are cached (Step 2.4). */
  TOOLBRIDGE_CACHE_DIR: z.string().min(1).default('.cache/specs'),
  /** Port for the Streamable HTTP transport (always bound to 127.0.0.1). */
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
});

export interface McpServerConfig {
  spec: string;
  overridesFile: string;
  cacheDir: string;
  httpPort: number;
  /** The host API the tools call, and the service account they log in with. */
  hostApi: HostApiConfig;
}

/** Reads and validates the environment. Throws one readable error listing every problem. */
export function loadMcpServerConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid MCP server configuration:\n${z.prettifyError(result.error)}`);
  }
  const { TOOLBRIDGE_SPEC, TOOLBRIDGE_OVERRIDES, TOOLBRIDGE_CACHE_DIR, MCP_HTTP_PORT } =
    result.data;
  /** Leaves URLs alone; makes file paths absolute from the repo root. */
  const fromRoot = (path: string): string =>
    /^https?:\/\//i.test(path) ? path : resolve(REPO_ROOT, path);
  return {
    spec: fromRoot(TOOLBRIDGE_SPEC),
    overridesFile: fromRoot(TOOLBRIDGE_OVERRIDES),
    cacheDir: fromRoot(TOOLBRIDGE_CACHE_DIR),
    httpPort: MCP_HTTP_PORT,
    hostApi: loadHostApiConfig(env),
  };
}
