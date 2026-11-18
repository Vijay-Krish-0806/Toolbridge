/**
 * The intermediate representation (IR) of an API: one small, predictable shape that every later
 * stage (tool generator, HTTP executor, MCP server) reads instead of raw OpenAPI.
 *
 * Everything here is plain JSON (no cycles), so it can be snapshotted, hashed and cached.
 */

/** A JSON Schema fragment, kept as-is from the spec (3.0 or 3.1 dialect). */
export type JsonSchema = Record<string, unknown>;

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface Parameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  description?: string;
  deprecated: boolean;
  schema: JsonSchema;
}

export interface RequestBody {
  required: boolean;
  description?: string;
  /** The one content type we picked (JSON preferred), plus every type the spec offered. */
  contentType: string;
  availableContentTypes: string[];
  schema: JsonSchema;
}

export interface Response {
  /** HTTP status code as written in the spec, for example "200", "4XX" or "default". */
  status: string;
  description: string;
  contentType?: string;
  schema?: JsonSchema;
}

/** One security requirement: every scheme listed must be satisfied together (AND). */
export type SecurityRequirement = Record<string, string[]>;

export interface SecurityScheme {
  type: string;
  description?: string;
  /** http schemes: "bearer", "basic", ... */
  scheme?: string;
  bearerFormat?: string;
  /** apiKey schemes: where the key goes and under which name. */
  in?: string;
  name?: string;
}

export interface Operation {
  /** Stable id: the spec's operationId, or "METHOD /path" when it has none. */
  id: string;
  operationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  tags: string[];
  /** Path-level and operation-level parameters merged; the operation wins on (in, name). */
  parameters: Parameter[];
  requestBody?: RequestBody;
  responses: Response[];
  /** Effective security: the operation's own, else the document default. Any one entry (OR) is enough; [] means public. */
  security: SecurityRequirement[];
}

export interface ApiModel {
  title: string;
  version: string;
  openapiVersion: string;
  servers: string[];
  securitySchemes: Record<string, SecurityScheme>;
  operations: Operation[];
  /**
   * Targets of `$ref`s left in place because they are part of a cycle (for example a tree node
   * that contains child nodes), keyed by the ref string such as "#/components/schemas/Node".
   */
  schemas: Record<string, JsonSchema>;
}

/** Something the compiler skipped or could not fully understand, reported instead of crashing. */
export interface CompileWarning {
  /** Operation id the warning belongs to, if any. */
  operation?: string;
  message: string;
}

export interface NormalizeResult {
  model: ApiModel;
  warnings: CompileWarning[];
}
