/**
 * Pure compiler front end: turns a dereferenced OpenAPI 3.x document into the ApiModel IR.
 * No I/O. Anything it cannot use is reported as a warning instead of throwing.
 */
import type { OpenAPIV3 } from 'openapi-types';

import type { OpenApi3Document } from './load.js';
import type {
  ApiModel,
  CompileWarning,
  HttpMethod,
  JsonSchema,
  NormalizeResult,
  Operation,
  Parameter,
  RequestBody,
  Response,
  SecurityScheme,
} from './model.js';

const HTTP_METHODS: readonly HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/**
 * A dereferenced object may still be `{ $ref }` when the ref was left in place (cyclic or external).
 * 3.0 and 3.1 share the shapes we read here, so 3.1 documents are read through the 3.0 types.
 */
type Maybe<T> = T | OpenAPIV3.ReferenceObject;

/** Collects warnings while one document is normalized. */
class Warnings {
  readonly list: CompileWarning[] = [];

  /** Records one warning, tagged with the operation it came from when known. */
  add(message: string, operation?: string): void {
    this.list.push(operation === undefined ? { message } : { operation, message });
  }
}

/**
 * Normalizes a whole document.
 *
 * Before -> after: `paths['/orders/{id}'].get` (+ path-level params, doc-level security) ->
 * `{ id: 'OrdersController_getById', method: 'get', path: '/orders/{id}', parameters: [...], security: [...] }`.
 */
export function normalize(doc: OpenApi3Document): NormalizeResult {
  const spec = doc as OpenAPIV3.Document;
  const warnings = new Warnings();
  const operations: Operation[] = [];
  const seenIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op === undefined) continue;

      const operation = normalizeOperation(spec, path, method, pathItem, op, warnings);
      if (seenIds.has(operation.id)) {
        warnings.add(
          `Duplicate operation id "${operation.id}"; later stages need unique ids.`,
          operation.id,
        );
      }
      seenIds.add(operation.id);
      operations.push(operation);
    }
  }

  const model: ApiModel = {
    title: spec.info.title,
    version: spec.info.version,
    openapiVersion: spec.openapi,
    servers: (spec.servers ?? []).map((server) => server.url),
    securitySchemes: normalizeSecuritySchemes(spec.components?.securitySchemes, warnings),
    operations,
    schemas: collectCyclicSchemas(spec, operations, warnings),
  };
  return { model, warnings: warnings.list };
}

/**
 * Builds one Operation: merges parameters, picks body and response content types, and resolves
 * which security applies.
 */
function normalizeOperation(
  spec: OpenAPIV3.Document,
  path: string,
  method: HttpMethod,
  pathItem: OpenAPIV3.PathItemObject,
  op: OpenAPIV3.OperationObject,
  warnings: Warnings,
): Operation {
  const id = op.operationId ?? `${method.toUpperCase()} ${path}`;
  if (op.operationId === undefined) {
    warnings.add('No operationId; using "METHOD /path" as the id.', id);
  }

  const requestBody = normalizeRequestBody(op.requestBody, id, warnings);
  return {
    id,
    ...(op.operationId !== undefined && { operationId: op.operationId }),
    method,
    path,
    ...(op.summary !== undefined && { summary: op.summary }),
    ...(op.description !== undefined && { description: op.description }),
    deprecated: op.deprecated ?? false,
    tags: op.tags ?? [],
    parameters: mergeParameters(pathItem.parameters, op.parameters, id, warnings),
    ...(requestBody !== undefined && { requestBody }),
    responses: normalizeResponses(op.responses, id, warnings),
    // An operation's own `security` (even []) replaces the document default; it is not merged.
    security: op.security ?? spec.security ?? [],
  };
}

/**
 * Merges path-level and operation-level parameters. A parameter is identified by (in, name), and
 * the operation-level one wins, as the OpenAPI spec says.
 * Before -> after: path `[id]` + op `[id (overridden), limit]` -> `[id (op version), limit]`.
 */
function mergeParameters(
  pathLevel: Maybe<OpenAPIV3.ParameterObject>[] | undefined,
  opLevel: Maybe<OpenAPIV3.ParameterObject>[] | undefined,
  opId: string,
  warnings: Warnings,
): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const raw of [...(pathLevel ?? []), ...(opLevel ?? [])]) {
    if ('$ref' in raw) {
      warnings.add(`Parameter ${raw.$ref} could not be resolved; skipped.`, opId);
      continue;
    }
    const location = raw.in as Parameter['in'];
    byKey.set(`${location}:${raw.name}`, {
      name: raw.name,
      in: location,
      // Path parameters are always required, even if the spec forgets to say so.
      required: location === 'path' ? true : (raw.required ?? false),
      ...(raw.description !== undefined && { description: raw.description }),
      deprecated: raw.deprecated ?? false,
      schema: parameterSchema(raw, opId, warnings),
    });
  }
  return [...byKey.values()];
}

/**
 * A parameter describes its type either with `schema` (common) or with `content` (rare, for
 * complex values). Returns whichever is present, or an empty schema with a warning.
 */
function parameterSchema(
  param: OpenAPIV3.ParameterObject,
  opId: string,
  warnings: Warnings,
): JsonSchema {
  if (param.schema !== undefined) return param.schema as JsonSchema;
  const media = param.content === undefined ? undefined : pickMediaType(param.content);
  if (media?.schema !== undefined) return media.schema as JsonSchema;
  warnings.add(`Parameter "${param.name}" has no schema; treating it as any value.`, opId);
  return {};
}

/**
 * Picks one content type for the request body (JSON preferred).
 * Before -> after: `{ content: { 'application/json': { schema } } }` ->
 * `{ contentType: 'application/json', availableContentTypes: ['application/json'], schema }`.
 */
function normalizeRequestBody(
  body: Maybe<OpenAPIV3.RequestBodyObject> | undefined,
  opId: string,
  warnings: Warnings,
): RequestBody | undefined {
  if (body === undefined) return undefined;
  if ('$ref' in body) {
    warnings.add(`Request body ${body.$ref} could not be resolved; skipped.`, opId);
    return undefined;
  }

  const media = pickMediaType(body.content);
  if (media === undefined) {
    warnings.add('Request body has no content types; skipped.', opId);
    return undefined;
  }
  if (!isJson(media.contentType)) {
    warnings.add(
      `Request body is ${media.contentType}, not JSON; later stages may not support it.`,
      opId,
    );
  }
  return {
    required: body.required ?? false,
    ...(body.description !== undefined && { description: body.description }),
    contentType: media.contentType,
    availableContentTypes: Object.keys(body.content),
    schema: (media.schema ?? {}) as JsonSchema,
  };
}

/**
 * Flattens the responses map into a list, picking one content type per status.
 * Before -> after: `{ '200': { description, content: {...} } }` -> `[{ status: '200', description, contentType, schema }]`.
 */
function normalizeResponses(
  responses: OpenAPIV3.ResponsesObject,
  opId: string,
  warnings: Warnings,
): Response[] {
  const result: Response[] = [];
  for (const [status, response] of Object.entries(responses)) {
    if ('$ref' in response) {
      warnings.add(`Response ${status} ${response.$ref} could not be resolved; skipped.`, opId);
      continue;
    }
    const media = response.content === undefined ? undefined : pickMediaType(response.content);
    result.push({
      status,
      description: response.description,
      ...(media !== undefined && { contentType: media.contentType }),
      ...(media?.schema !== undefined && { schema: media.schema as JsonSchema }),
    });
  }
  return result;
}

/**
 * Chooses one entry from a `content` map: `application/json` first, then any other JSON type
 * (such as `application/problem+json`), then whatever comes first.
 */
function pickMediaType(
  content: Record<string, OpenAPIV3.MediaTypeObject>,
): { contentType: string; schema?: unknown } | undefined {
  const types = Object.keys(content);
  const chosen = types.find((t) => t === 'application/json') ?? types.find(isJson) ?? types[0];
  if (chosen === undefined) return undefined;
  return { contentType: chosen, schema: content[chosen]?.schema };
}

/** True for `application/json`, `application/json; charset=utf-8` and `+json` types. */
function isJson(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json');
}

/** Keeps only the security-scheme fields later stages need (type, scheme, where an API key goes). */
function normalizeSecuritySchemes(
  schemes: Record<string, Maybe<OpenAPIV3.SecuritySchemeObject>> | undefined,
  warnings: Warnings,
): Record<string, SecurityScheme> {
  const result: Record<string, SecurityScheme> = {};
  for (const [name, scheme] of Object.entries(schemes ?? {})) {
    if ('$ref' in scheme) {
      warnings.add(`Security scheme "${name}" (${scheme.$ref}) could not be resolved; skipped.`);
      continue;
    }
    const raw = scheme as unknown as Record<string, unknown>;
    const out: SecurityScheme = { type: scheme.type };
    for (const key of ['description', 'scheme', 'bearerFormat', 'in', 'name'] as const) {
      const value = raw[key];
      if (typeof value === 'string') out[key] = value;
    }
    result[name] = out;
  }
  return result;
}

/**
 * Finds every `$ref` still left inside operation schemas (cycles, or blocked external refs).
 * Internal ones (`#/...`) are looked up in the document and returned by ref string, following
 * refs inside those targets too. External ones become warnings, since we refuse to fetch them.
 * Before -> after: a schema containing `{ $ref: '#/components/schemas/Node' }` ->
 * `{ '#/components/schemas/Node': { type: 'object', properties: { children: { items: { $ref } } } } }`.
 */
function collectCyclicSchemas(
  spec: OpenAPIV3.Document,
  operations: Operation[],
  warnings: Warnings,
): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  const pending: { ref: string; opId?: string }[] = [];

  for (const op of operations) {
    const roots = [
      ...op.parameters.map((p) => p.schema),
      ...(op.requestBody ? [op.requestBody.schema] : []),
      ...op.responses.flatMap((r) => (r.schema ? [r.schema] : [])),
    ];
    for (const ref of findRefs(roots)) pending.push({ ref, opId: op.id });
  }

  const reportedExternal = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { ref, opId } = next;
    if (ref in schemas) continue;
    if (!ref.startsWith('#/')) {
      const key = `${opId ?? ''}|${ref}`;
      if (!reportedExternal.has(key)) {
        reportedExternal.add(key);
        warnings.add(
          `External $ref "${ref}" was not loaded (external refs are disabled for safety).`,
          opId,
        );
      }
      continue;
    }
    const target = resolvePointer(spec, ref);
    if (target === undefined) {
      warnings.add(`$ref "${ref}" points at nothing in the document.`, opId);
      continue;
    }
    schemas[ref] = target;
    for (const inner of findRefs([target]))
      pending.push({ ref: inner, ...(opId !== undefined && { opId }) });
  }
  return schemas;
}

/**
 * Walks a value and returns every `$ref` string inside it. Uses a `seen` set because a
 * dereferenced document shares objects between places, and may share a lot.
 */
function findRefs(roots: unknown[]): Set<string> {
  const refs = new Set<string>();
  const seen = new Set<object>();
  const stack: unknown[] = [...roots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') refs.add(record.$ref);
    stack.push(...Object.values(record));
  }
  return refs;
}

/**
 * Follows a JSON Pointer inside the document.
 * Before -> after: `'#/components/schemas/Node'` -> `spec.components.schemas.Node`.
 * Pointer escapes: `~1` means `/` and `~0` means `~`; the ref may also be URL-encoded.
 */
function resolvePointer(spec: OpenAPIV3.Document, ref: string): JsonSchema | undefined {
  let node: unknown = spec;
  for (const raw of ref.slice(2).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined; // malformed %-escape: treat as an unresolvable ref
    }
    const key = decoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchema) : undefined;
}
