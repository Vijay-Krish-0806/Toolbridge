import type { Connection } from 'mongoose';
import { registerModels } from '../domain/models.js';
import type { Dataset } from './generate.js';

/**
 * Resets the database to exactly the given dataset:
 * 1. drop the whole database, so no leftover data survives;
 * 2. build indexes first, so unique constraints are enforced while inserting;
 * 3. insert in dependency order (referenced records before the records that point to them).
 * insertMany runs schema validation, so a generator bug fails here rather than in the API later.
 */
export async function writeDataset(connection: Connection, data: Dataset): Promise<void> {
  const models = registerModels(connection);

  await connection.dropDatabase();
  for (const model of Object.values(models)) {
    await model.createIndexes();
  }

  await models.products.insertMany(data.products);
  await models.inventory.insertMany(data.inventory);
  await models.customers.insertMany(data.customers);
  await models.coupons.insertMany(data.coupons);
  await models.orders.insertMany(data.orders);
  await models.shipments.insertMany(data.shipments);
  await models.refunds.insertMany(data.refunds);
}
