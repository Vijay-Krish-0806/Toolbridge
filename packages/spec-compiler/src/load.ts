/**
 * The I/O edge of spec-compiler: reads a spec from a file or URL. Loading has two steps with very
 * different costs (measured on GitHub's 14 MB spec): parsing takes about 0.1 s, validating and
 * dereferencing about 1.3 s. Keeping them separate lets the cache (compile.ts) hash the parsed
 * spec and skip validation entirely when the content is unchanged.
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
 * Safety settings shared by both steps:
 * - `resolve.external: false`: never follow a `$ref` to another file or URL. By default the parser
 *   would read any file a `$ref` points at (Local File Inclusion), so an uploaded spec could pull
 *   in `/etc/passwd` or a `.env`. Such refs stay as `$ref` and normalize() reports them.
 * - The HTTP resolver keeps its defaults (`safeUrlResolver` on, 50 MiB max) and gets a timeout.
 */
function resolveOptions(options: LoadOptions) {
  return { external: false, http: { timeout: options.timeoutMs ?? 15_000 } };
}

/**
 * Step 1 (cheap): reads and parses the spec (JSON or YAML), without resolving `$ref`s or
 * validating. `source` is a local file path or an http(s) URL.
 * Before -> after: a file path -> the raw document object, `$ref`s still in place.
 */
export async function parseSpec(
  source: string,
  options: LoadOptions = {},
): Promise<OpenAPI.Document> {
  try {
    return await SwaggerParser.parse(source, { resolve: resolveOptions(options) });
  } catch (error) {
    throw loadError(source, error);
  }
}

/**
 * Step 2 (expensive): validates a parsed document and dereferences its `$ref`s, in place.
 * `dereference.circular: 'ignore'` keeps refs that form a cycle as `$ref` instead of creating
 * circular JS objects, so the result can still be turned into JSON.
 * Before -> after: `{ schema: { $ref: '#/components/schemas/Order' } }` ->
 * `{ schema: { type: 'object', properties: {...} } }`.
 */
export async function validateSpec(
  doc: OpenAPI.Document,
  source: string,
  options: LoadOptions = {},
): Promise<OpenApi3Document> {
  if (!isOpenApi3(doc)) {
    throw new SpecLoadError(
      `${source} is Swagger 2.0. Only OpenAPI 3.x is supported; convert it first (for example with swagger2openapi).`,
    );
  }
  try {
    return (await SwaggerParser.validate(doc, {
      resolve: resolveOptions(options),
      dereference: { circular: 'ignore' },
    })) as OpenApi3Document;
  } catch (error) {
    throw loadError(source, error);
  }
}

/** Both steps in one call: a validated, dereferenced OpenAPI 3.x document. */
export async function loadSpec(
  source: string,
  options: LoadOptions = {},
): Promise<OpenApi3Document> {
  return validateSpec(await parseSpec(source, options), source, options);
}

/** Wraps a parser failure with the source, plus a hint for URLs (the parser's own message is vague). */
function loadError(source: string, error: unknown): SpecLoadError {
  const reason = error instanceof Error ? error.message : String(error);
  // The parser's message for a blocked or unreachable URL is just "Unable to resolve $ref pointer".
  const hint = /^https?:\/\//i.test(source)
    ? ' (URLs that are unreachable, time out, or point at localhost/private addresses are refused; for a local API, load its exported spec file instead)'
    : '';
  return new SpecLoadError(`Could not load spec from ${source}: ${reason}${hint}`, {
    cause: error,
  });
}

/** Type guard: true for OpenAPI 3.0/3.1 documents (they have an `openapi` field), false for Swagger 2.0 (`swagger: "2.0"`). */
function isOpenApi3(api: OpenAPI.Document): api is OpenApi3Document {
  return 'openapi' in api;
}
