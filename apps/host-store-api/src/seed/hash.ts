import mongoose from 'mongoose';
import { loadConfig } from '../config.js';

/**
 * Prints MongoDB's own fingerprint (the dbHash command) of the host database.
 * Run it after two seeds: identical hashes mean the seed is deterministic.
 */
const config = loadConfig();
const connection = await mongoose
  .createConnection(config.MONGO_URI, { dbName: config.MONGO_DB })
  .asPromise();

try {
  const result = await connection.db?.command({ dbHash: 1 });
  const collections = (result?.collections ?? {}) as Record<string, string>;
  for (const [name, md5] of Object.entries(collections).sort()) {
    console.log(`${name.padEnd(10)} ${md5}`);
  }
  console.log(`${'database'.padEnd(10)} ${String(result?.md5)}`);
} finally {
  await connection.close();
}
