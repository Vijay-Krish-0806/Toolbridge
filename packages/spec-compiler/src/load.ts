/**
 * The only module in spec-compiler that does I/O: it reads a spec from a file or URL and hands
 * back a validated, dereferenced OpenAPI 3.x document. Everything after this is pure.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

export type OpenApi3Document = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface LoadOptions {
  /** How long to wait for a URL to respond. Default 15 s. */
  timeoutMs?: number;
}

/** Thrown when a spec cannot be read, is not OpenAPI 3.x, or fails validation. */
export class SpecLoadError extends Error {
  override readonly name = 'SpecLoadError';
}

/**
 * Loads a spec and returns it validated and dereferenced.
 *
 * `source` is a local file path or an http(s) URL; JSON and YAML both work.
 * Before -> after: `{ schema: { $ref: '#/components/schemas/Order' } }` ->
 * `{ schema: { type: 'object', properties: {...} } }`.
 *
 * Safety settings, and why:
 * - `resolve.external: false`: never follow a `$ref` to another file or URL. By default the parser
 *   would read any file a `$ref` points at (Local File Inclusion), so an uploaded spec could pull
 *   in `/etc/passwd` or a `.env`. Such refs stay as `$ref` and normalize() reports them.
 * - `dereference.circular: 'ignore'`: refs that form a cycle stay as `$ref` instead of becoming
 *   circular JS objects, so the result can still be turned into JSON.
 * - The HTTP resolver keeps its defaults (`safeUrlResolver` on, 50 MiB max) and gets a timeout.
 */
export async function loadSpec(
  source: string,
  options: LoadOptions = {},
): Promise<OpenApi3Document> {
  let api: OpenAPI.Document;
  try {
    api = await SwaggerParser.validate(source, {
      resolve: { external: false, http: { timeout: options.timeoutMs ?? 15_000 } },
      dereference: { circular: 'ignore' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The parser's message for a blocked or unreachable URL is just "Unable to resolve $ref pointer".
    const hint = /^https?:\/\//i.test(source)
      ? ' (URLs that are unreachable, time out, or point at localhost/private addresses are refused; for a local API, load its exported spec file instead)'
      : '';
    throw new SpecLoadError(`Could not load spec from ${source}: ${reason}${hint}`, {
      cause: error,
    });
  }

  if (!isOpenApi3(api)) {
    throw new SpecLoadError(
      `${source} is Swagger 2.0. Only OpenAPI 3.x is supported; convert it first (for example with swagger2openapi).`,
    );
  }
  return api;
}

/** Type guard: true for OpenAPI 3.0/3.1 documents (they have an `openapi` field), false for Swagger 2.0 (`swagger: "2.0"`). */
function isOpenApi3(api: OpenAPI.Document): api is OpenApi3Document {
  return 'openapi' in api;
}
