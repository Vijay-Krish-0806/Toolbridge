/**
 * MCP tool annotations derived from a compiled tool. Annotations are hints a host may use, for
 * example to skip a confirmation for read-only tools. They are never security: the spec says
 * clients must not trust them from untrusted servers. Every default is the cautious one
 * (not read-only, destructive, open world), so leaving a hint out is always safe.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { ToolDefinition } from '@toolbridge/spec-compiler';

/** HTTP methods that are idempotent by definition: repeating them has no extra effect. */
const IDEMPOTENT_METHODS = new Set(['put', 'delete']);

/**
 * Maps a tool to its hints.
 * - readOnlyHint: the tool only reads (GET/HEAD/OPTIONS).
 * - destructiveHint: it may change or remove existing data. True for PUT/PATCH/DELETE, for a
 *   POST on an existing resource (a path parameter, as in /orders/{id}/cancel), and for anything
 *   marked high risk. A POST to a collection (/orders) only adds, so it is false.
 * - idempotentHint: PUT and DELETE.
 * - openWorldHint: false. The tools reach one known API, not arbitrary external entities.
 * Before -> after: orders_cancel (POST /orders/{id}/cancel, high risk) ->
 * `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }`.
 */
export function toAnnotations(tool: ToolDefinition): ToolAnnotations {
  if (tool.safety === 'read') return { readOnlyHint: true, openWorldHint: false };
  const destructive =
    tool.risk === 'high' ||
    tool.variants.some(
      (v) => ['put', 'patch', 'delete'].includes(v.method) || /\{[^}]+\}/.test(v.path),
    );
  return {
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: tool.variants.every((v) => IDEMPOTENT_METHODS.has(v.method)),
    openWorldHint: false,
  };
}
