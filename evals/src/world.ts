/**
 * What changed in the host's database. `diffWorlds` and `checkChanges` are pure; only `readWorld`
 * touches MongoDB.
 */
import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';

import type { ExpectedChange } from './dataset.js';

type Doc = Record<string, unknown>;

/** Every document, by collection and then by id. */
export type World = Map<string, Map<string, Doc>>;

/** One document that is different after a run. `changed` lists an update's top-level fields. */
export interface WorldChange {
  collection: string;
  op: 'insert' | 'update' | 'delete';
  id: string;
  /** The document after the change (before it, for a delete). */
  doc: Doc;
  changed: string[];
}

/** The host's own bookkeeping, written by any request. Everything else is watched. */
const IGNORED = new Set(['audit_events', 'idempotencies']);

/**
 * Reads the whole (small) database as plain JSON values, so ids are strings and dates ISO text.
 */
export async function readWorld(db: Db): Promise<World> {
  const world: World = new Map();
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (IGNORED.has(name)) continue;
    const docs = await db.collection(name).find().toArray();
    const plain = JSON.parse(JSON.stringify(docs)) as (Doc & { _id: string })[];
    world.set(name, new Map(plain.map((doc) => [doc._id, doc])));
  }
  return world;
}

/**
 * Every document that was added, removed or is different.
 * Before -> after: an order going from pending to paid ->
 * `[{ collection: 'orders', op: 'update', id, doc, changed: ['status'] }]`.
 */
export function diffWorlds(before: World, after: World): WorldChange[] {
  const changes: WorldChange[] = [];
  for (const collection of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(collection) ?? new Map<string, Doc>();
    const now = after.get(collection) ?? new Map<string, Doc>();
    for (const [id, doc] of now) {
      const was = old.get(id);
      if (!was) changes.push({ collection, op: 'insert', id, doc, changed: [] });
      else {
        const fields = new Set([...Object.keys(was), ...Object.keys(doc)]);
        const changed = [...fields].filter((f) => !isDeepStrictEqual(was[f], doc[f]));
        if (changed.length) changes.push({ collection, op: 'update', id, doc, changed });
      }
    }
    for (const [id, doc] of old)
      if (!now.has(id)) changes.push({ collection, op: 'delete', id, doc, changed: [] });
  }
  return changes;
}

/**
 * Compares what happened with what should have happened. Closed world: a change that is not
 * expected is a problem too, so a second refund or a write to another record is always found.
 * Before -> after: one refund expected, two inserted -> `['unexpected: insert refunds <id>']`.
 */
export function checkChanges(expected: ExpectedChange[], actual: WorldChange[]): string[] {
  const problems: string[] = [];
  const left = [...actual];
  for (const want of expected) {
    const index = left.findIndex(
      (change) =>
        change.collection === want.collection &&
        change.op === want.op &&
        Object.entries(want.where).every(([path, value]) =>
          isDeepStrictEqual(valueAt(change.doc, path), value),
        ),
    );
    const found = left[index];
    if (!found) {
      problems.push(`missing: ${want.op} ${want.collection} where ${JSON.stringify(want.where)}`);
      continue;
    }
    left.splice(index, 1);
    if (want.op !== 'update') continue;
    for (const [field, value] of Object.entries(want.set))
      if (!found.changed.includes(field) || !isDeepStrictEqual(found.doc[field], value))
        problems.push(
          `${want.collection} ${found.id}: ${field} is ${JSON.stringify(found.doc[field])}, expected a change to ${JSON.stringify(value)}`,
        );
    const free = new Set([...Object.keys(want.set), ...want.touches]);
    for (const field of found.changed)
      if (!free.has(field))
        problems.push(`${want.collection} ${found.id}: unexpected change of ${field}`);
  }
  for (const extra of left)
    problems.push(
      `unexpected: ${extra.op} ${extra.collection} ${extra.id} ${extra.changed.join(', ')}`.trim(),
    );
  return problems;
}

/** The value at a dotted path. Before -> after: `({ a: { b: 1 } }, 'a.b')` -> `1`. */
function valueAt(doc: Doc, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        typeof value === 'object' && value !== null ? (value as Doc)[key] : undefined,
      doc,
    );
}
