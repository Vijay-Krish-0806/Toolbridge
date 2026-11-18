/**
 * Turns compiled ToolDefinitions (plain data from spec-compiler) into runnable agent-core Tools.
 * They then go through the same ToolExecutor as the hand-written ones, so argument validation,
 * timeouts, read-only retries and the result cap all apply unchanged.
 */
import type { SecurityScheme, ToolDefinition } from '@toolbridge/spec-compiler';
import { z } from 'zod';

import type { Tool } from '../tools/tool.js';
import { type AuthProvider, applyAuth } from './auth.js';
import { parseBody, responseError } from './errors.js';
import type { SafeHttpClient } from './http-client.js';
import { type Args, buildRequest, selectVariant } from './request.js';

export interface OpenApiToolsOptions {
  /** Where the API lives, for example http://127.0.0.1:3000 or https://api.example.com/v1. */
  baseUrl: string | URL;
  /** The spec's security schemes (ApiModel.securitySchemes). */
  securitySchemes: Record<string, SecurityScheme>;
  /** Supplies credentials; omit for public APIs. */
  auth?: AuthProvider;
  client: SafeHttpClient;
}

type JsonSchemaInput = Parameters<typeof z.fromJSONSchema>[0];

/**
 * Builds one Tool per definition.
 * Before -> after: `{ name: 'orders_get', inputSchema, variants: [...] }` ->
 * `{ name: 'orders_get', input: <Zod from inputSchema>, parameters: inputSchema, execute }`.
 */
export function createOpenApiTools(
  definitions: ToolDefinition[],
  options: OpenApiToolsOptions,
): Tool[] {
  const baseUrl = new URL(options.baseUrl);
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    safety: definition.safety,
    // z.fromJSONSchema is marked semi-experimental in zod 4.6.7; it is used once per tool, here.
    input: z.fromJSONSchema(definition.inputSchema as JsonSchemaInput),
    parameters: definition.inputSchema,
    execute: (args: unknown, { signal }) =>
      callOperation(definition, args as Args, baseUrl, options, signal),
  }));
}

/**
 * Runs one tool call: pick the variant, build the request, add credentials, send it. On a 401,
 * if the auth provider can refresh (a login token expired), it is retried once with new
 * credentials. Error statuses become ToolExecutionErrors with the API's message.
 */
async function callOperation(
  definition: ToolDefinition,
  args: Args,
  baseUrl: URL,
  options: OpenApiToolsOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const binding = selectVariant(definition, args);
  const label = `${binding.method.toUpperCase()} ${binding.path}`;

  /** Builds a fresh request each time, so a retry gets fresh credentials. */
  const send = async () => {
    const request = buildRequest(binding, args, baseUrl);
    await applyAuth(request, binding.security, options.securitySchemes, options.auth, signal);
    return options.client.send(request, signal);
  };

  let response = await send();
  if (response.status === 401 && options.auth?.invalidate?.() === true) response = await send();
  if (response.status >= 400) throw responseError(response, label);
  return parseBody(response);
}
