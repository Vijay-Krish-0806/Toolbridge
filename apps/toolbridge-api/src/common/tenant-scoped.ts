/**
 * The one door to tenant data. In the pool model every tenant's documents share a collection, so
 * isolation depends on every query carrying `tenantId`. Instead of trusting each service to
 * remember it, services get a TenantScoped store that adds the filter itself and cannot be built
 * without a tenant id. A forgotten filter becomes impossible, not just unlikely.
 */
import { Types } from 'mongoose';

export type Filter = Record<string, unknown>;

/**
 * The few collection operations the platform needs, without tenant scoping. The Mongoose adapter
 * (mongooseCollection) implements it; tests can use a plain in-memory fake.
 */
export interface Collection<T> {
  find(filter: Filter, sort?: Record<string, 1 | -1>): Promise<T[]>;
  findOne(filter: Filter): Promise<T | null>;
  insertOne(doc: Omit<T, '_id'>): Promise<T>;
  /** Applies `$set`; returns how many documents matched. */
  updateOne(filter: Filter, set: Filter): Promise<number>;
  countDocuments(filter: Filter): Promise<number>;
  /** Returns how many documents were deleted (0 or 1). */
  deleteOne(filter: Filter): Promise<number>;
}

/** Thrown when code tries to use tenant data without a valid tenant, or to cross tenants. */
export class TenantScopeError extends Error {
  override readonly name = 'TenantScopeError';
}

/**
 * A store whose every operation is limited to one tenant.
 * Before -> after: `scoped.find({ name: 'shop' })` -> `collection.find({ name: 'shop', tenantId })`.
 */
export class TenantScoped<T extends { tenantId: Types.ObjectId }> {
  private readonly tenantId: Types.ObjectId;

  /** Refuses to exist without a real tenant id: no undefined, no empty string, no "any". */
  constructor(
    private readonly collection: Collection<T>,
    tenantId: Types.ObjectId | string | undefined | null,
  ) {
    if (tenantId instanceof Types.ObjectId) this.tenantId = tenantId;
    else if (typeof tenantId === 'string' && /^[a-f0-9]{24}$/.test(tenantId)) {
      this.tenantId = new Types.ObjectId(tenantId);
    } else {
      throw new TenantScopeError('A tenant id is required to access tenant data.');
    }
  }

  /** All matching documents of this tenant. */
  find(filter: Filter = {}, sort?: Record<string, 1 | -1>): Promise<T[]> {
    return this.collection.find(this.scope(filter), sort);
  }

  /** One matching document of this tenant, or null (also when it belongs to someone else). */
  findOne(filter: Filter): Promise<T | null> {
    return this.collection.findOne(this.scope(filter));
  }

  /** Inserts a document owned by this tenant; any tenantId in `doc` is overwritten. */
  insertOne(doc: Omit<T, '_id' | 'tenantId'>): Promise<T> {
    return this.collection.insertOne({ ...doc, tenantId: this.tenantId } as Omit<T, '_id'>);
  }

  /** Updates one document of this tenant. The update may not change `tenantId`. */
  updateOne(filter: Filter, set: Filter): Promise<number> {
    if ('tenantId' in set) throw new TenantScopeError('tenantId cannot be changed.');
    return this.collection.updateOne(this.scope(filter), set);
  }

  /** Deletes one document of this tenant. */
  deleteOne(filter: Filter): Promise<number> {
    return this.collection.deleteOne(this.scope(filter));
  }

  /** Counts this tenant's matching documents. */
  countDocuments(filter: Filter = {}): Promise<number> {
    return this.collection.countDocuments(this.scope(filter));
  }

  /**
   * Adds the tenant condition. A filter that names a tenantId itself is refused rather than
   * silently overwritten: it is a bug (or an attack) and should be loud.
   */
  private scope(filter: Filter): Filter {
    if ('tenantId' in filter) {
      throw new TenantScopeError('Filters must not set tenantId; the scope adds it.');
    }
    return { ...filter, tenantId: this.tenantId };
  }
}
