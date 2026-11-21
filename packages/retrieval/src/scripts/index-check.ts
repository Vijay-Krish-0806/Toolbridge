/**
 * Step 3.1 acceptance check: incremental reindex re-embeds only what changed.
 * Run with `pnpm --filter @toolbridge/retrieval index:check`. Needs MongoDB (pnpm infra:up) and
 * Ollama with the embedding model. Uses its own scratch database, wiped at the start of each run.
 *
 * 1. index the host spec from empty  -> every tool embedded
 * 2. reindex unchanged               -> nothing embedded
 * 3. edit one tool's description     -> exactly 1 embedded
 * 4. revert the edit                 -> 1 from the embedding cache, 0 embedded
 * 5. drop one tool                   -> 1 removed
 * 6. a few searches                  -> top 3 tools with scores
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileSpec, type ToolDefinition } from '@toolbridge/spec-compiler';
import { MongoClient } from 'mongodb';
import { z } from 'zod';

import { loadEmbeddingConfig } from '../config.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { type IndexScope, type ReindexSummary, ToolIndex } from '../tool-index.js';

const CHECK_DB = 'toolbridge_retrieval_check';
const SCOPE: IndexScope = { tenantId: 'check-tenant', specId: 'host-store' };
const QUERIES = [
  'refund a damaged order',
  'which orders are late?',
  'how much did we sell last month',
  'change the price of a product',
];

const root = resolve(import.meta.dirname, '../../../..');
let failed = false;

/** Runs one reindex, prints its counts and time, and checks them against what we expect. */
async function step(
  label: string,
  index: ToolIndex,
  tools: ToolDefinition[],
  expect: Partial<ReindexSummary>,
): Promise<void> {
  const started = performance.now();
  const summary = await index.reindex(SCOPE, tools);
  const ms = Math.round(performance.now() - started);
  const ok = Object.entries(expect).every(
    ([key, value]) => summary[key as keyof ReindexSummary] === value,
  );
  if (!ok) failed = true;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${JSON.stringify(summary)}  ${String(ms)} ms`,
  );
  if (!ok) console.log(`      expected ${JSON.stringify(expect)}`);
}

/** Repeats a search until the eventually consistent index returns k results (or 15 s pass). */
async function searchWhenReady(index: ToolIndex, query: string, k: number) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const matches = await index.search(SCOPE, query, k);
    if (matches.length === k || Date.now() > deadline) return matches;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Compiles the host spec, then runs the steps against a scratch database. */
async function main(): Promise<void> {
  const { MONGO_URI } = z.object({ MONGO_URI: z.string().min(1) }).parse(process.env);
  const overrides: unknown = JSON.parse(
    await readFile(resolve(root, 'specs/host-store.overrides.json'), 'utf8'),
  );
  const { tools } = await compileSpec(resolve(root, 'specs/host-store.json'), { overrides });
  const config = loadEmbeddingConfig();
  const provider = new OllamaEmbeddingProvider(config);
  console.log(
    `${String(tools.length)} tools, model ${config.model}, ${String(config.dimensions)} dimensions\n`,
  );

  const client = await MongoClient.connect(MONGO_URI);
  try {
    const db = client.db(CHECK_DB);
    await db.dropDatabase();
    const index = new ToolIndex(db, provider);
    await index.ensureIndexes();

    const n = tools.length;
    await step('1. index from empty', index, tools, { embedded: n, unchanged: 0 });
    await step('2. reindex, nothing changed', index, tools, { embedded: 0, unchanged: n });

    const edited = tools.map((t) =>
      t.name === 'orders_cancel'
        ? { ...t, description: `${t.description} Edited for the check.` }
        : t,
    );
    await step('3. edit orders_cancel', index, edited, {
      embedded: 1,
      fromCache: 0,
      unchanged: n - 1,
    });
    await step('4. revert the edit', index, tools, { embedded: 0, fromCache: 1, unchanged: n - 1 });
    await step(
      '5. drop forms_order_form',
      index,
      tools.filter((t) => t.name !== 'forms_order_form'),
      {
        removed: 1,
        embedded: 0,
      },
    );

    console.log('\nSearch (top 3):');
    for (const query of QUERIES) {
      const matches = await searchWhenReady(index, query, 3);
      const shown = matches.map((m) => `${m.toolName} ${m.score.toFixed(3)}`).join(', ');
      console.log(`  "${query}"\n    -> ${shown}`);
    }
  } finally {
    await client.close();
  }
  if (failed) process.exitCode = 1;
}

await main();
