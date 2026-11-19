/**
 * Content fingerprints. A canonical form first, so that the same content always gives the same
 * hash: reformatting a spec or reordering its keys must not count as a change.
 */
import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every level and no whitespace. Array order is kept, because in
 * JSON (and OpenAPI) array order can carry meaning. Undefined values are dropped, as JSON.stringify does.
 * Before -> after: `{ b: 1, a: { d: 2, c: 3 } }` -> `'{"a":{"c":3,"d":2},"b":1}'`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  // Input is parsed JSON, so the only non-JSON value that can arrive is undefined.
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/** SHA-256 of a string, as 64 hex characters. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The content fingerprint of any JSON-like value: sha256 of its canonical JSON. */
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
