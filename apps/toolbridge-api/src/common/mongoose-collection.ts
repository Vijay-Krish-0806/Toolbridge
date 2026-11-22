/**
 * Adapts a Mongoose model to the small Collection interface that TenantScoped uses.
 * Keeping the interface small means the scoping rules can be tested without a database.
 */
import type { Model, QueryFilter } from 'mongoose';

import type { Collection, Filter } from './tenant-scoped.js';

/** Wraps `model` so its documents come back as plain objects (`lean`). */
export function mongooseCollection<T>(model: Model<T>): Collection<T> {
  const filterOf = (filter: Filter): QueryFilter<T> => filter;
  return {
    find: (filter, sort) =>
      model
        .find(filterOf(filter))
        .sort(sort ?? {})
        .lean<T[]>()
        .exec(),
    findOne: (filter) => model.findOne(filterOf(filter)).lean<T>().exec(),
    insertOne: async (doc) => (await new model(doc).save()).toObject(),
    updateOne: async (filter, set) =>
      (await model.updateOne(filterOf(filter), { $set: set }).exec()).matchedCount,
    findOneAndUpdate: (filter, set) =>
      model
        .findOneAndUpdate(filterOf(filter), { $set: set }, { returnDocument: 'after' })
        .lean<T>()
        .exec(),
    countDocuments: (filter) => model.countDocuments(filterOf(filter)).exec(),
    deleteOne: async (filter) => (await model.deleteOne(filterOf(filter)).exec()).deletedCount,
  };
}
