/**
 * Builds the tools generated from specs/host-store.json (+ overrides) for scripts. Shared by the
 * chat CLI and the knowledge eval, so both run the agent with the same tools.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  compileTools,
  loadSpec,
  normalize,
  parseOverrides,
  type ToolDefinition as CompiledTool,
} from '@toolbridge/spec-compiler';

import { loadHostApiConfig } from '../config.js';
import { TokenLogin } from '../openapi/auth.js';
import { createOpenApiTools } from '../openapi/generated-tools.js';
import { SafeHttpClient } from '../openapi/http-client.js';
import type { Tool } from '../tools/tool.js';

/**
 * Compiles the host spec and its overrides into tools (Steps 2.1 to 2.3) that call the host API
 * through the SSRF-safe client, logged in as the configured staff account. Also returns the
 * compiled definitions, which the tool index embeds.
 */
export async function createGeneratedTools(): Promise<{ tools: Tool[]; compiled: CompiledTool[] }> {
  const config = loadHostApiConfig();
  const specs = resolve(import.meta.dirname, '../../../../specs');
  const { model } = normalize(await loadSpec(resolve(specs, 'host-store.json')));
  const overrides = parseOverrides(
    JSON.parse(await readFile(resolve(specs, 'host-store.overrides.json'), 'utf8')),
  );
  const client = new SafeHttpClient({ allowPrivateHosts: [new URL(config.baseUrl).hostname] });
  const auth = new TokenLogin({
    client,
    loginUrl: new URL('/auth/login', config.baseUrl),
    credentials: { email: config.email, password: config.password },
    tokenField: 'accessToken',
  });
  const { tools } = compileTools(model, overrides);
  return {
    tools: createOpenApiTools(tools, {
      baseUrl: config.baseUrl,
      securitySchemes: model.securitySchemes,
      auth,
      client,
    }),
    compiled: tools,
  };
}
