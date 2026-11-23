/**
 * A LangGraph STORE on MongoDB driver v7 (Step 4.7, ADR 0045): long-term memory with expiry.
 *
 * Checkpointer and store, in one line each: the checkpointer (MongoSaver) keeps ONE run's state so
 * it can continue; the store keeps items that outlive runs, addressed by a NAMESPACE (a list of
 * labels, for example [tenant, spec, user, 'memories']) and a key.
 *
 * Two things LangGraph's JS store API does not give (checked in 1.2.3), added here:
 * - EXPIRY: every item has `expiresAt`. A TTL index lets MongoDB delete it, and every read also
 *   skips expired items, because TTL deletion runs in the background and can be late. Saving an
 *   item again starts its time over.
 * - A CLOSED DOOR between namespaces: the base class lets `search([])` return every item of every
 *   tenant. Here an empty namespace is refused, and listing namespaces is not supported at all.
 *
 * Only what is needed is supported: get, put, delete, and search by namespace prefix. Semantic
 * search (`query`) and `filter` are refused, not silently ignored.
 */
import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
} from '@langchain/langgraph-checkpoint';
import type { Collection, Db, Filter } from 'mongodb';

interface StoreDoc {
  /**
   * The namespace joined with NUL (a label can never contain it). One string, not an array: a
   * unique index on an array would apply to each label alone, so two users could not have the
   * same key.
   */
  path: string;
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface MongoStoreOptions {
  /** The database to keep items in (the caller owns the client and its lifetime). */
  db: Db;
  /** How long an item lives after it was last saved. */
  ttlMs: number;
  /** Default: `store_items`. */
  collection?: string;
}

const SEPARATOR = '\u0000';

export class MongoStore extends BaseStore {
  private readonly items: Collection<StoreDoc>;
  private readonly ttlMs: number;

  constructor(options: MongoStoreOptions) {
    super();
    this.items = options.db.collection(options.collection ?? 'store_items');
    this.ttlMs = options.ttlMs;
  }

  /** Creates the indexes: one item per namespace and key, and expiry. Safe on every start. */
  async setup(): Promise<void> {
    await this.items.createIndex(
      { path: 1, key: 1 },
      { unique: true, name: 'path_key' },
      undefined,
    );
    await this.items.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'expiry' },
      undefined,
    );
  }

  /**
   * The one method LangGraph's base class needs: `get`, `put`, `delete` and `search` are all built
   * on it. Operations run in order, so a put followed by a get sees the put.
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const operation of operations) results.push(await this.run(operation));
    return results as OperationResults<Op>;
  }

  private async run(operation: Operation): Promise<Item | SearchItem[] | null | undefined> {
    if ('namespacePrefix' in operation) {
      if (operation.query !== undefined) throw new Error('MongoStore: query is not supported.');
      if (operation.filter !== undefined) throw new Error('MongoStore: filter is not supported.');
      return this.find(operation.namespacePrefix, operation.limit, operation.offset);
    }
    if (!('key' in operation)) throw new Error('MongoStore: listing namespaces is not supported.');
    if (!('value' in operation)) return this.read(operation.namespace, operation.key);
    if (operation.value === null) {
      await this.items.deleteOne({ path: pathOf(operation.namespace), key: operation.key });
    } else {
      await this.write(operation.namespace, operation.key, operation.value);
    }
    return undefined;
  }

  /** One live item, or null. */
  private async read(namespace: string[], key: string): Promise<Item | null> {
    const doc = await this.items.findOne({
      path: pathOf(namespace),
      key,
      expiresAt: { $gt: new Date() },
    });
    return doc ? toItem(doc) : null;
  }

  /** Inserts or replaces an item and starts its lifetime over; `createdAt` is kept. */
  private async write(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    await this.items.updateOne(
      { path: pathOf(namespace), key },
      {
        $set: { namespace, value, updatedAt: now, expiresAt: new Date(now.getTime() + this.ttlMs) },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  /**
   * Live items in a namespace and the namespaces under it, newest first.
   * Before -> after: (['t1', 's1'], 10) -> items of ['t1', 's1'] and ['t1', 's1', 'u1'], never
   * of ['t1', 's10'].
   */
  private async find(prefix: string[], limit = 10, offset = 0): Promise<SearchItem[]> {
    const path = pathOf(prefix);
    const query: Filter<StoreDoc> = {
      // Exactly this namespace, or any that continues it with another label.
      $or: [{ path }, { path: { $gte: path + SEPARATOR, $lt: `${path}\u0001` } }],
      expiresAt: { $gt: new Date() },
    };
    const docs = await this.items
      .find(query)
      .sort({ updatedAt: -1, key: 1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    return docs.map(toItem);
  }
}

/**
 * The namespace as one string. Refuses an empty namespace (it would mean "everything") and labels
 * that are empty or contain NUL (two different namespaces could become the same string).
 */
function pathOf(namespace: string[]): string {
  if (namespace.length === 0) throw new Error('MongoStore: a namespace is required.');
  for (const label of namespace) {
    if (typeof label !== 'string' || label === '' || label.includes(SEPARATOR)) {
      throw new Error('MongoStore: namespace labels must be non-empty strings without NUL.');
    }
  }
  return namespace.join(SEPARATOR);
}

function toItem(doc: StoreDoc): Item {
  const { namespace, key, value, createdAt, updatedAt } = doc;
  return { namespace, key, value, createdAt, updatedAt };
}
