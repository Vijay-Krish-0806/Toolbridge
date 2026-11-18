/**
 * Tool naming rules. Names must match ^[a-zA-Z0-9_-]{1,64}$: the OpenAI function-name rule,
 * which also fits MCP's recommendation (1-128 chars of letters, digits, _ - .).
 */
import { createHash } from 'node:crypto';

import type { Operation } from '../model.js';

export const MAX_TOOL_NAME_LENGTH = 64;
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Turns any identifier into snake_case words.
 * Before -> after: `getByID` -> `get_by_id`, `repos/get-content` -> `repos_get_content`,
 * `GET /orders/{id}` -> `get_orders_id`.
 */
export function toSnakeCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // fooBar -> foo_Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // HTTPServer -> HTTP_Server
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * The automatic name for an operation, before overrides and de-duplication.
 * NestJS operation ids look like `OrdersController_getById`; the word "Controller" is noise.
 * Before -> after: `OrdersController_getById` -> `orders_get_by_id`; no operationId and
 * `GET /orders/{id}` -> `get_orders_id`.
 */
export function defaultToolName(op: Operation): string {
  const source = op.operationId?.replace(/Controller_/, '_') ?? `${op.method} ${op.path}`;
  return fitName(toSnakeCase(source));
}

/**
 * Makes any name valid: replaces bad characters, and if it is too long, cuts it and adds a short
 * hash of the full name so two long names that share a beginning still differ.
 * Before -> after: a 90-char name -> its first 55 chars + `_` + 8 hex chars (64 total).
 */
export function fitName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'tool';
  if (clean.length <= MAX_TOOL_NAME_LENGTH) return clean;
  const hash = createHash('sha256').update(clean).digest('hex').slice(0, 8);
  return `${clean.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
}

/**
 * Returns `name`, or `name_2`, `name_3`, ... if it is already taken, and records it as taken.
 * Suffixed names are refitted, so they also stay within 64 characters.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${String(n)}`;
    candidate = `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}
