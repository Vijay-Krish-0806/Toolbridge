/**
 * Generic result shaping for generated tools (ADR 0011: shaping beats truncation).
 * Two rules:
 * - Pagination hints, for every tool: a page `{ items, page, limit, total }` also says
 *   `hasMore` and `nextPage`, so the model pages correctly instead of guessing.
 * - Field allowlists, where the overrides file sets one: only those fields are kept (per item
 *   for lists). Free-text fields left out also mean less room for prompt injection in data.
 */
import type { ResultShape } from '@toolbridge/spec-compiler';

type Json = Record<string, unknown>;

interface Page {
  items: unknown[];
  page: number;
  limit: number;
  total: number;
}

/**
 * Shapes one parsed response.
 * Before -> after (orders_list, fields [number, status]):
 * `{ items: [{ _id, number, status, items: [...], notes, ... }], page: 1, limit: 20, total: 50 }` ->
 * `{ page: 1, total: 50, hasMore: true, nextPage: 2, items: [{ number, status }] }`.
 * Responses that are neither a page, a list nor an allowlisted object are returned unchanged.
 */
export function shapeResult(body: unknown, shape: ResultShape | undefined): unknown {
  const keep = (value: unknown): unknown => (shape ? pick(value, shape.fields) : value);
  if (isPage(body)) {
    const { page, limit, total } = body;
    const hasMore = page * limit < total;
    // Paging fields go first: if the executor truncates a long result, it cuts trailing items,
    // not the hint that tells the model to fetch the next page.
    return {
      page,
      total,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
      items: body.items.map(keep),
    };
  }
  if (Array.isArray(body)) return body.map(keep);
  return keep(body);
}

/** True for the page-number pagination shape `{ items: [], page, limit, total }`. */
function isPage(body: unknown): body is Page {
  if (!isRecord(body)) return false;
  return (
    Array.isArray(body.items) &&
    typeof body.page === 'number' &&
    typeof body.limit === 'number' &&
    typeof body.total === 'number'
  );
}

/**
 * Keeps only the listed fields, rebuilding nested objects for dot paths. Missing fields are
 * skipped. Non-objects are returned unchanged.
 * Before -> after: `{ order: { number: 'ORD-1', notes: '...' }, daysLate: 3 }` with
 * `['order.number', 'daysLate']` -> `{ order: { number: 'ORD-1' }, daysLate: 3 }`.
 */
function pick(value: unknown, fields: string[]): unknown {
  if (!isRecord(value)) return value;
  const out: Json = {};
  for (const path of fields) {
    const keys = path.split('.');
    const found = keys.reduce<unknown>(
      (node, key) => (isRecord(node) ? node[key] : undefined),
      value,
    );
    if (found === undefined) continue;
    let target = out;
    for (const key of keys.slice(0, -1)) {
      const next = isRecord(target[key]) ? target[key] : {};
      target[key] = next;
      target = next;
    }
    target[keys.at(-1) ?? path] = found;
  }
  return out;
}

/** True for plain objects (not arrays or null). */
function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
