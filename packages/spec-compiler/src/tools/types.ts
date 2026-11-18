/**
 * What the tool generator produces. Like the IR, it is plain JSON data: no Zod, no functions.
 * The MCP server (2.5) sends `inputSchema` as-is, and the HTTP executor (2.3) uses `variants`
 * to turn a tool call back into an HTTP request.
 */
import type { HttpMethod, JsonSchema, ParameterLocation, SecurityRequirement } from '../model.js';

export type SafetyClass = 'read' | 'write';
export type RiskLevel = 'low' | 'medium' | 'high';

/** Where one tool argument goes in the HTTP request. `name` is the real parameter or body field name. */
export interface ArgBinding {
  in: ParameterLocation | 'body';
  name: string;
}

/** Everything 2.3 needs to call one operation for this tool. */
export interface Binding {
  operationId: string;
  method: HttpMethod;
  path: string;
  security: SecurityRequirement[];
  /** Tool argument name -> where it goes. Lets the model see flat `{ id, reason }`. */
  args: Record<string, ArgBinding>;
  /** Tool arguments this variant needs; used to pick a variant of a merged tool. */
  requiredArgs: string[];
  /** Set when the operation has a body. */
  bodyContentType?: string;
  /**
   * Set when the body is not an object (for example an array): the whole argument named here
   * is sent as the body.
   */
  wholeBodyArg?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** A flat JSON Schema object of all arguments. */
  inputSchema: JsonSchema;
  safety: SafetyClass;
  risk: RiskLevel;
  /** Usually one. More when several operations were merged; 2.3 runs the first whose required args are all present. */
  variants: Binding[];
}

export interface ToolWarning {
  /** Tool name or operation id the warning belongs to, if any. */
  subject?: string;
  message: string;
}

export interface CompileToolsResult {
  tools: ToolDefinition[];
  warnings: ToolWarning[];
}
