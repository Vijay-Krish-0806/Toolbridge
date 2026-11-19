/**
 * Compares two versions of an API (two ApiModels) and says what changed, and whether each change
 * is breaking. "Breaking" means an existing tool call could start failing or mean something else:
 * an agent, a saved workflow or a pending approval written against the old version may stop working.
 *
 * Operations are matched by HTTP identity (method + path), with path-parameter names ignored,
 * so `/orders/{id}` -> `/orders/{orderId}` is one changed operation, not a removal plus an addition.
 */
import type { ApiModel, JsonSchema, Operation, Parameter } from './model.js';
import { canonicalJson } from './hash.js';
import { resolveSchema } from './tools/result.js';

/** Schemas are compared this many levels deep; deeper differences are not reported. */
const MAX_DEPTH = 6;

export interface Change {
  breaking: boolean;
  message: string;
}

export interface OperationRef {
  id: string;
  method: string;
  path: string;
}

export interface OperationChange extends OperationRef {
  breaking: boolean;
  changes: Change[];
}

export interface SpecDiff {
  added: OperationRef[];
  removed: OperationRef[];
  changed: OperationChange[];
  /** True if anything removed or changed is breaking. */
  breaking: boolean;
}

type Refs = Record<string, JsonSchema>;
/** Which way data flows: request fields are sent by our tools, response fields are read by them. */
type Direction = 'request' | 'response';

/**
 * Diffs two API versions.
 * Before -> after: v1 with `GET /orders/{id}`, v2 where that operation also needs `?tenant=` ->
 * `{ changed: [{ path: '/orders/{id}', breaking: true, changes: [{ breaking: true, message: 'query parameter "tenant" added as required' }] }], breaking: true }`.
 */
export function diffModels(before: ApiModel, after: ApiModel): SpecDiff {
  const oldOps = byIdentity(before.operations);
  const newOps = byIdentity(after.operations);

  const removed = [...oldOps].filter(([key]) => !newOps.has(key)).map(([, op]) => ref(op));
  const added = [...newOps].filter(([key]) => !oldOps.has(key)).map(([, op]) => ref(op));
  const changed: OperationChange[] = [];
  for (const [key, oldOp] of oldOps) {
    const newOp = newOps.get(key);
    if (newOp === undefined) continue;
    const changes = diffOperation(oldOp, newOp, before.schemas, after.schemas);
    if (changes.length > 0) {
      changed.push({ ...ref(newOp), breaking: changes.some((c) => c.breaking), changes });
    }
  }
  return {
    added,
    removed,
    changed,
    breaking: removed.length > 0 || changed.some((c) => c.breaking),
  };
}

/** Indexes operations by `METHOD /path` with parameter names blanked: `GET /orders/{}`. */
function byIdentity(operations: Operation[]): Map<string, Operation> {
  return new Map(
    operations.map((op) => [
      `${op.method.toUpperCase()} ${op.path.replace(/\{[^}]+\}/g, '{}')}`,
      op,
    ]),
  );
}

/** The short reference printed for an operation. */
function ref(op: Operation): OperationRef {
  return { id: op.id, method: op.method.toUpperCase(), path: op.path };
}

/** All changes between two versions of one operation. */
function diffOperation(a: Operation, b: Operation, refsA: Refs, refsB: Refs): Change[] {
  const changes: Change[] = [];
  const add = (breaking: boolean, message: string): void => {
    changes.push({ breaking, message });
  };

  if (a.operationId !== b.operationId) {
    add(
      true,
      `operationId "${String(a.operationId)}" -> "${String(b.operationId)}" (the generated tool name changes)`,
    );
  }
  if (!a.deprecated && b.deprecated) add(false, 'now deprecated');
  if (a.deprecated && !b.deprecated) add(false, 'no longer deprecated');

  const secA = canonicalJson(a.security);
  const secB = canonicalJson(b.security);
  if (secA !== secB) {
    if (b.security.length === 0) add(false, 'no longer requires auth');
    else if (a.security.length === 0) add(true, 'now requires auth');
    else add(true, `auth requirements changed: ${secA} -> ${secB}`);
  }

  changes.push(...diffParameters(a.parameters, b.parameters, refsA, refsB));
  changes.push(...diffBodies(a, b, refsA, refsB));

  const okA = successSchema(a);
  const okB = successSchema(b);
  if (okA !== undefined && okB !== undefined) {
    changes.push(...diffSchema('response', okA, okB, 'response', refsA, refsB, 0));
  } else if (okA !== undefined) {
    add(true, 'success response no longer has a body');
  }
  return changes;
}

/** Parameters are matched by (location, name). */
function diffParameters(a: Parameter[], b: Parameter[], refsA: Refs, refsB: Refs): Change[] {
  const changes: Change[] = [];
  const key = (p: Parameter): string => `${p.in}:${p.name}`;
  const newByKey = new Map(b.map((p) => [key(p), p]));
  const oldKeys = new Set(a.map(key));

  for (const p of a) {
    const q = newByKey.get(key(p));
    const label = `${p.in} parameter "${p.name}"`;
    if (q === undefined) {
      changes.push({ breaking: true, message: `${label} removed` });
      continue;
    }
    if (!p.required && q.required)
      changes.push({ breaking: true, message: `${label} is now required` });
    if (p.required && !q.required)
      changes.push({ breaking: false, message: `${label} is now optional` });
    changes.push(...diffSchema(label, p.schema, q.schema, 'request', refsA, refsB, 0));
  }
  for (const q of b) {
    if (oldKeys.has(key(q))) continue;
    const message = `${q.in} parameter "${q.name}" added${q.required ? ' as required' : ''}`;
    changes.push({ breaking: q.required, message });
  }
  return changes;
}

/** Request body presence, content type, required flag and schema. */
function diffBodies(a: Operation, b: Operation, refsA: Refs, refsB: Refs): Change[] {
  const x = a.requestBody;
  const y = b.requestBody;
  if (x === undefined && y === undefined) return [];
  if (x === undefined && y !== undefined) {
    return [
      { breaking: y.required, message: `request body added${y.required ? ' as required' : ''}` },
    ];
  }
  if (x !== undefined && y === undefined)
    return [{ breaking: true, message: 'request body removed' }];
  if (x === undefined || y === undefined) return [];

  const changes: Change[] = [];
  if (x.contentType !== y.contentType) {
    changes.push({
      breaking: true,
      message: `request body type ${x.contentType} -> ${y.contentType}`,
    });
  }
  if (!x.required && y.required)
    changes.push({ breaking: true, message: 'request body is now required' });
  changes.push(...diffSchema('body', x.schema, y.schema, 'request', refsA, refsB, 0));
  return changes;
}

/** The schema of the first 2xx response that has one. */
function successSchema(op: Operation): JsonSchema | undefined {
  return op.responses.find((r) => r.status.startsWith('2') && r.schema !== undefined)?.schema;
}

/**
 * Compares two schemas at `label`, recursing into properties and array items.
 * Request side: our tools send this data, so anything the API would now reject is breaking
 * (removed field, new required field, narrower enum, different type).
 * Response side: our tools and agents read this data, so a removed field or a different type is
 * breaking; new fields and enum values are not.
 */
function diffSchema(
  label: string,
  a: JsonSchema,
  b: JsonSchema,
  direction: Direction,
  refsA: Refs,
  refsB: Refs,
  depth: number,
): Change[] {
  if (depth > MAX_DEPTH) return [];
  const x = resolveSchema(a, refsA);
  const y = resolveSchema(b, refsB);
  const changes: Change[] = [];

  const typeA = typeName(x);
  const typeB = typeName(y);
  if (typeA !== typeB && typeA !== undefined && typeB !== undefined) {
    // Different type: nested comparisons would only repeat the same news.
    return [{ breaking: true, message: `${label}: type ${typeA} -> ${typeB}` }];
  }

  changes.push(...diffEnum(label, x.enum, y.enum, direction));

  const propsA = (x.properties ?? {}) as Record<string, JsonSchema>;
  const propsB = (y.properties ?? {}) as Record<string, JsonSchema>;
  const requiredA = new Set(asStrings(x.required));
  const requiredB = new Set(asStrings(y.required));
  for (const [name, schemaA] of Object.entries(propsA)) {
    const schemaB = propsB[name];
    const field = `${label}.${name}`;
    if (schemaB === undefined) {
      changes.push({ breaking: true, message: `${field} removed` });
      continue;
    }
    if (direction === 'request' && !requiredA.has(name) && requiredB.has(name)) {
      changes.push({ breaking: true, message: `${field} is now required` });
    }
    changes.push(...diffSchema(field, schemaA, schemaB, direction, refsA, refsB, depth + 1));
  }
  for (const name of Object.keys(propsB)) {
    if (name in propsA) continue;
    const required = direction === 'request' && requiredB.has(name);
    changes.push({
      breaking: required,
      message: `${label}.${name} added${required ? ' as required' : ''}`,
    });
  }

  if (x.items !== undefined && y.items !== undefined) {
    changes.push(
      ...diffSchema(
        `${label}[]`,
        x.items as JsonSchema,
        y.items as JsonSchema,
        direction,
        refsA,
        refsB,
        depth + 1,
      ),
    );
  }
  return changes;
}

/**
 * Enum changes. Request side: removing a value is breaking (we might still send it), adding is
 * not. Response side: new values may surprise a reader but rarely break a call, so neither is.
 */
function diffEnum(label: string, a: unknown, b: unknown, direction: Direction): Change[] {
  if (!Array.isArray(a) && !Array.isArray(b)) return [];
  const before = new Set((Array.isArray(a) ? a : []).map((v) => JSON.stringify(v)));
  const after = new Set((Array.isArray(b) ? b : []).map((v) => JSON.stringify(v)));
  const gone = [...before].filter((v) => !after.has(v));
  const added = [...after].filter((v) => !before.has(v));
  const changes: Change[] = [];
  if (Array.isArray(a) && !Array.isArray(b)) {
    changes.push({ breaking: false, message: `${label}: enum removed (any value allowed)` });
  } else if (!Array.isArray(a) && Array.isArray(b)) {
    changes.push({
      breaking: direction === 'request',
      message: `${label}: now limited to ${[...after].join(', ')}`,
    });
  } else {
    if (gone.length > 0) {
      changes.push({
        breaking: direction === 'request',
        message: `${label}: enum values removed ${gone.join(', ')}`,
      });
    }
    if (added.length > 0)
      changes.push({ breaking: false, message: `${label}: enum values added ${added.join(', ')}` });
  }
  return changes;
}

/** `type` as one comparable string: `"integer"`, or `"null|string"` for type arrays. */
function typeName(schema: JsonSchema): string | undefined {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return (type as unknown[]).map(String).sort().join('|');
  return undefined;
}

/** The string entries of an unknown value, for `required` lists. */
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
