import mongoose from 'mongoose';
import { loadConfig } from '../config.js';
import { DEFAULT_SEED, generateDataset } from './generate.js';
import { writeDataset } from './write.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error(
    'Refusing to seed: the seed drops the whole database, and NODE_ENV is production.',
  );
}

const data = generateDataset(config.SEED_STAFF_PASSWORD, DEFAULT_SEED);
// autoIndex is off: write.ts builds indexes itself, at a known point, after dropping the database.
const connection = await mongoose
  .createConnection(config.MONGO_URI, { dbName: config.MONGO_DB, autoIndex: false })
  .asPromise();

try {
  await writeDataset(connection, data);
  const counts = Object.entries(data)
    .filter(([key]) => key !== 'injectionTargets')
    .map(([key, rows]) => `${key}=${String((rows as unknown[]).length)}`)
    .join(' ');
  console.log(`Seeded "${config.MONGO_DB}" with seed ${String(DEFAULT_SEED)}: ${counts}`);
} finally {
  await connection.close();
}
