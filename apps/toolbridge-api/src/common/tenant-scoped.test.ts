/**
 * The tenant-scoped store is the platform's isolation boundary, so it is pinned by tests:
 * it cannot be created without a tenant id, and every operation it performs carries that id.
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { type Collection, type Filter, TenantScoped, TenantScopeError } from './tenant-scoped.js';

interface Doc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
}

/** A fake collection that records every filter it receives, so tests can inspect them. */
function recordingCollection(): { collection: Collection<Doc>; filters: Filter[] } {
  const filters: Filter[] = [];
  const collection: Collection<Doc> = {
    find: (filter) => {
      filters.push(filter);
      return Promise.resolve([]);
    },
    findOne: (filter) => {
      filters.push(filter);
      return Promise.resolve(null);
    },
    insertOne: (doc) => Promise.resolve({ ...doc, _id: new Types.ObjectId() }),
    updateOne: (filter) => {
      filters.push(filter);
      return Promise.resolve(0);
    },
    findOneAndUpdate: (filter) => {
      filters.push(filter);
      return Promise.resolve(null);
    },
    countDocuments: (filter) => {
      filters.push(filter);
      return Promise.resolve(0);
    },
    deleteOne: (filter) => {
      filters.push(filter);
      return Promise.resolve(0);
    },
  };
  return { collection, filters };
}

const TENANT = new Types.ObjectId();

describe('TenantScoped', () => {
  it.each([undefined, null, '', 'not-an-id', '*'])(
    'cannot be created without a tenant id (%j)',
    (id) => {
      const { collection } = recordingCollection();
      expect(() => new TenantScoped(collection, id)).toThrow(TenantScopeError);
    },
  );

  it('adds the tenant id to every query', async () => {
    const { collection, filters } = recordingCollection();
    const scoped = new TenantScoped(collection, TENANT);
    await scoped.find({ name: 'shop' });
    await scoped.findOne({ _id: new Types.ObjectId() });
    await scoped.updateOne({ name: 'shop' }, { name: 'store' });
    await scoped.countDocuments();
    await scoped.deleteOne({ name: 'shop' });
    await scoped.findOneAndUpdate({ name: 'shop' }, { name: 'store' });
    expect(filters).toHaveLength(6);
    for (const filter of filters) expect(filter.tenantId).toEqual(TENANT);
  });

  it('refuses filters that try to choose a tenant', () => {
    const { collection } = recordingCollection();
    const scoped = new TenantScoped(collection, TENANT);
    expect(() => scoped.find({ tenantId: new Types.ObjectId() })).toThrow(TenantScopeError);
  });

  it('stamps its own tenant id on inserts and never lets an update move a document', async () => {
    const { collection } = recordingCollection();
    const scoped = new TenantScoped(collection, TENANT);
    const other = new Types.ObjectId();
    const inserted = await scoped.insertOne({ name: 'shop', tenantId: other } as unknown as Omit<
      Doc,
      '_id' | 'tenantId'
    >);
    expect(inserted.tenantId).toEqual(TENANT);
    expect(() => scoped.updateOne({ name: 'shop' }, { tenantId: other })).toThrow(TenantScopeError);
    expect(() => scoped.findOneAndUpdate({ name: 'shop' }, { tenantId: other })).toThrow(
      TenantScopeError,
    );
  });
});
