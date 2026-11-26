/**
 * Operator command: loads a folder of markdown policies for one API of one tenant (ADR 0054).
 *   pnpm --filter @toolbridge/toolbridge-api knowledge:load --tenant <id> --spec <id> --dir knowledge/host-store
 *   add --clear (instead of --dir) to remove the documents again
 * Running it again only embeds changed sections. Needs MongoDB and Ollama (the embedding model).
 * Tenants cannot load documents themselves yet: that is why their text counts as trusted.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { connectKnowledgeIndex, loadKnowledgeDir } from '@toolbridge/retrieval';
import mongoose, { isValidObjectId, Types } from 'mongoose';

import { loadConfig, type PlatformConfig } from '../config.js';
import { knowledgeScope } from '../runs/knowledge.js';

/** True when the spec exists and is this tenant's: a typo must not mix two tenants' documents. */
async function specBelongsTo(
  config: PlatformConfig,
  tenantId: Types.ObjectId,
  specId: Types.ObjectId,
): Promise<boolean> {
  const connection = await mongoose
    .createConnection(config.MONGO_URI, { dbName: config.PLATFORM_MONGO_DB })
    .asPromise();
  try {
    return (await connection.collection('specs').findOne({ _id: specId, tenantId })) !== null;
  } finally {
    await connection.close();
  }
}

/** Reads the arguments, checks them, and brings the stored documents in line with the folder. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      tenant: { type: 'string' },
      spec: { type: 'string' },
      dir: { type: 'string' },
      clear: { type: 'boolean', default: false },
    },
  });
  const { tenant, spec, dir, clear } = values;
  if (!isValidObjectId(tenant) || !isValidObjectId(spec) || (dir === undefined) !== clear) {
    throw new Error('Usage: knowledge:load --tenant <id> --spec <id> (--dir <folder> | --clear)');
  }
  const tenantId = new Types.ObjectId(tenant);
  const specId = new Types.ObjectId(spec);
  const config = loadConfig();
  if (!(await specBelongsTo(config, tenantId, specId))) {
    throw new Error('This tenant has no such spec.');
  }
  // pnpm runs scripts in the package's folder; INIT_CWD is where the person typed the command.
  const chunks =
    dir === undefined
      ? []
      : await loadKnowledgeDir(resolve(process.env.INIT_CWD ?? process.cwd(), dir));
  if (dir !== undefined && chunks.length === 0) {
    throw new Error(`No markdown sections in ${dir}. Use --clear to remove the documents.`);
  }

  const { index, close } = await connectKnowledgeIndex({
    mongoUri: config.MONGO_URI,
    dbName: config.PLATFORM_MONGO_DB,
    embedding: config.embedding,
  });
  try {
    const scope = knowledgeScope(tenantId, specId);
    const summary = await index.reindex(scope, chunks);
    const last = chunks.at(-1);
    if (last && summary.unchanged < summary.total) await index.waitUntilSearchable(scope, last);
    console.log(`Documents of spec ${specId.toHexString()}: ${JSON.stringify(summary)}`);
  } finally {
    await close();
  }
}

await main();
