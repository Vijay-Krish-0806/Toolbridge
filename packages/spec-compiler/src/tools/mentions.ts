/**
 * Specs often point at other endpoints in prose ("Find it with GET /customers?search=").
 * The model never sees HTTP routes, only tool names, so these hints are rewritten to name the
 * tool instead. Mentions of routes that did not become a tool (hidden ones) are left as they are.
 */
import type { JsonSchema } from '../model.js';
import type { ToolDefinition } from './types.js';

/** `METHOD /path` with an optional `?param=` hint. A path never ends in `.`, so sentences keep their full stop. */
const ROUTE_MENTION =
  /\b(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS) (\/[A-Za-z0-9_/{}-]*)(?:\?([A-Za-z0-9_]+)=?)?/g;

/**
 * Rewrites route mentions in every tool's description and argument descriptions, in place.
 * Before -> after: `'Find it with GET /customers?search=.'` -> `'Find it with customers_list (search argument).'`
 */
export function linkMentions(tools: ToolDefinition[]): void {
  const toolByRoute = new Map<string, string>();
  for (const tool of tools) {
    for (const v of tool.variants)
      toolByRoute.set(`${v.method.toUpperCase()} ${v.path}`, tool.name);
  }

  /** Replaces each known `METHOD /path` with its tool name; unknown routes stay unchanged. */
  const rewrite = (text: string): string =>
    text.replace(ROUTE_MENTION, (match, method: string, path: string, param?: string) => {
      const name = toolByRoute.get(`${method} ${path}`);
      if (name === undefined) return match;
      return param === undefined ? name : `${name} (${param} argument)`;
    });

  for (const tool of tools) {
    tool.description = rewrite(tool.description);
    rewriteDescriptions(tool.inputSchema, rewrite);
  }
}

/** Walks a schema and applies `rewrite` to every `description` string. */
function rewriteDescriptions(schema: JsonSchema, rewrite: (text: string) => string): void {
  const stack: unknown[] = [schema];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node !== 'object' || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record.description === 'string') record.description = rewrite(record.description);
    stack.push(...Object.values(record));
  }
}
