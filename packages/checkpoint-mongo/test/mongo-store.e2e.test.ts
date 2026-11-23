/**
 * Step 4.7 (b): MongoStore. REQUIRED (isolation between namespaces: tenants and users are
 * namespaces) and data integrity (expired items are never returned). The first block runs the
 * same checks on LangGraph's own InMemoryStore, so our store behaves as the framework expects.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { type BaseStore, InMemoryStore } from '@langchain/langgraph-checkpoint';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MongoStore } from '../src/mongo-store.js';

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set (copy .env.example to .env).');
const client = new MongoClient(uri);
const db = client.db(`store_${randomUUID().slice(0, 8)}`);
const DAY = 86_400_000;

const mongo = new MongoStore({ db, ttlMs: DAY });

beforeAll(async () => {
  await client.connect();
  await mongo.setup();
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

describe.each<[string, BaseStore]>([
  ['InMemoryStore (reference)', new InMemoryStore()],
  ['MongoStore', mongo],
])('%s', (_name, store) => {
  it('puts, gets, replaces and deletes; a replace keeps createdAt', async () => {
    const ns = ['t1', 's1', 'crud'];
    expect(await store.get(ns, 'k')).toBeNull();
    await store.put(ns, 'k', { text: 'one' });
    const found = await store.get(ns, 'k');
    const first = { ...found }; // copied: InMemoryStore hands out the live object
    expect(found).toMatchObject({ namespace: ns, key: 'k', value: { text: 'one' } });
    await sleep(40);
    await store.put(ns, 'k', { text: 'two' });
    const second = await store.get(ns, 'k');
    expect(second?.value).toEqual({ text: 'two' });
    expect(second?.createdAt).toEqual(first.createdAt);
    expect(second?.updatedAt.getTime()).toBeGreaterThan(first.updatedAt?.getTime() ?? Infinity);
    await store.delete(ns, 'k');
    expect(await store.get(ns, 'k')).toBeNull();
  });

  it('keeps the same key in two namespaces apart', async () => {
    await store.put(['t1', 's1', 'ann'], 'same', { text: 'ann' });
    await store.put(['t1', 's1', 'bob'], 'same', { text: 'bob' });
    expect((await store.get(['t1', 's1', 'ann'], 'same'))?.value).toEqual({ text: 'ann' });
    await store.delete(['t1', 's1', 'bob'], 'same'); // the second one: not the first match
    expect((await store.get(['t1', 's1', 'ann'], 'same'))?.value).toEqual({ text: 'ann' });
    expect(await store.get(['t1', 's1', 'bob'], 'same')).toBeNull();
  });

  it('searches a namespace and those under it, never a neighbour with a longer name', async () => {
    await store.put(['find', 'user1'], 'a', { text: 'a' });
    await store.put(['find', 'user1', 'deep'], 'b', { text: 'b' });
    await store.put(['find', 'user10'], 'c', { text: 'c' });
    const keys = (await store.search(['find', 'user1'])).map((item) => item.key).sort();
    expect(keys).toEqual(['a', 'b']);
  });

  it('limits and pages', async () => {
    for (let i = 0; i < 5; i++) await store.put(['page'], `k${String(i)}`, { i });
    const one = await store.search(['page'], { limit: 2 });
    const two = await store.search(['page'], { limit: 2, offset: 2 });
    expect(one).toHaveLength(2);
    expect(new Set([...one, ...two].map((item) => item.key)).size).toBe(4);
  });
});

describe('MongoStore only', () => {
  it('refuses what would reach across namespaces, also through batch()', async () => {
    await expect(mongo.search([])).rejects.toThrow('a namespace is required');
    await expect(mongo.get([], 'k')).rejects.toThrow('a namespace is required');
    await expect(mongo.batch([{ namespacePrefix: [] }])).rejects.toThrow('a namespace is required');
    await expect(mongo.listNamespaces()).rejects.toThrow('not supported');
    await expect(mongo.batch([{ namespacePrefix: ['t1\u0000s1'] }])).rejects.toThrow('NUL');
  });

  it('refuses queries and filters instead of ignoring them', async () => {
    await expect(mongo.search(['t1'], { query: 'x' })).rejects.toThrow('query');
    await expect(mongo.search(['t1'], { filter: { a: 1 } })).rejects.toThrow('filter');
  });

  it('never returns an expired item, even before MongoDB has deleted it', async () => {
    const short = new MongoStore({ db, ttlMs: 200 });
    await short.put(['exp'], 'k', { text: 'soon gone' });
    expect(await short.get(['exp'], 'k')).not.toBeNull();
    await sleep(250);
    expect(await short.get(['exp'], 'k')).toBeNull();
    expect(await short.search(['exp'])).toEqual([]);
  });

  it('saving again starts the lifetime over', async () => {
    const short = new MongoStore({ db, ttlMs: 400 });
    await short.put(['renew'], 'k', { text: 'x' });
    await sleep(250);
    await short.put(['renew'], 'k', { text: 'x' });
    await sleep(250); // 500 ms after the first save, 250 ms after the second
    expect(await short.get(['renew'], 'k')).not.toBeNull();
  });

  it('has the TTL index that lets MongoDB delete expired items', async () => {
    const indexes = await db.collection('store_items').indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
  });
});
