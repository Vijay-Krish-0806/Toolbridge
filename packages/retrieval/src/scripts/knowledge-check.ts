/**
 * Step 3.3 ingest check: policies are chunked by heading and reindexed incrementally.
 * Run with `pnpm --filter @toolbridge/retrieval knowledge:check`. Needs MongoDB (pnpm infra:up)
 * and Ollama with the embedding model. Uses its own scratch database, wiped at the start.
 *
 * 1. chunk knowledge/host-store     -> chunk ids and sizes
 * 2. split a long synthetic section -> several parts at paragraph breaks
 * 3. index from empty               -> every chunk embedded
 * 4. reindex unchanged              -> nothing embedded
 * 5. edit one section               -> exactly 1 embedded
 * 6. revert the edit                -> 1 from the embedding cache
 * 7. drop one section               -> 1 removed
 * 8. a few searches                 -> top 3 chunks with scores
 */
import { resolve } from 'node:path';

import { MongoClient } from 'mongodb';
import { z } from 'zod';

import { loadEmbeddingConfig } from '../config.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { buildChunkText, chunkMarkdown, type KnowledgeChunk } from '../knowledge/chunker.js';
import { KnowledgeIndex, type KnowledgeScope } from '../knowledge/knowledge-index.js';
import { loadKnowledgeDir } from '../knowledge/load.js';
import type { ReindexSummary } from '../tool-index.js';

const CHECK_DB = 'toolbridge_knowledge_check';
const SCOPE: KnowledgeScope = { tenantId: 'check-tenant', source: 'host-store' };
const EDITED = 'refund-policy#damaged-items';
const QUERIES = [
  'the parcel arrived smashed, what do we do?',
  'who is allowed to ship orders?',
  'customer threatens to sue',
];

const root = resolve(import.meta.dirname, '../../../..');
let failed = false;

/** Prints PASS or FAIL for one check and remembers a failure for the exit code. */
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${detail}`);
}

/** Runs one reindex and checks its counts against what we expect. */
async function step(
  label: string,
  index: KnowledgeIndex,
  chunks: KnowledgeChunk[],
  expect: Partial<ReindexSummary>,
): Promise<void> {
  const started = performance.now();
  const summary = await index.reindex(SCOPE, chunks);
  const ms = Math.round(performance.now() - started);
  const ok = Object.entries(expect).every(
    ([key, value]) => summary[key as keyof ReindexSummary] === value,
  );
  check(label, ok, `${JSON.stringify(summary)}  ${String(ms)} ms`);
  if (!ok) console.log(`      expected ${JSON.stringify(expect)}`);
}

/** A long section of 6 paragraphs of ~400 characters, to show paragraph splitting. */
function longSectionCheck(): void {
  const paragraph = 'This sentence fills a paragraph. '.repeat(12).trim();
  const markdown = `# Test\n\n## Long section\n\n${Array(6).fill(paragraph).join('\n\n')}`;
  const chunks = chunkMarkdown('test', markdown, 1500);
  const ids = chunks.map((c) => `${c.id} (${String(c.text.length)})`).join(', ');
  check('long section split', chunks.length > 1 && chunks.every((c) => c.text.length <= 1500), ids);
}

/** Runs the checks in order, then closes the connection. */
async function main(): Promise<void> {
  const { MONGO_URI } = z.object({ MONGO_URI: z.string().min(1) }).parse(process.env);
  const provider = new OllamaEmbeddingProvider(loadEmbeddingConfig());
  const chunks = await loadKnowledgeDir(resolve(root, 'knowledge/host-store'));
  console.log(`${String(chunks.length)} chunks from knowledge/host-store:`);
  for (const c of chunks) {
    console.log(`  ${c.id.padEnd(48)} ${String(buildChunkText(c).length).padStart(5)} chars`);
  }
  longSectionCheck();

  const client = await MongoClient.connect(MONGO_URI);
  try {
    const db = client.db(CHECK_DB);
    await db.dropDatabase();
    const index = new KnowledgeIndex(db, provider);
    await index.ensureIndexes();

    const edited = chunks.map((c) =>
      c.id === EDITED ? { ...c, text: `${c.text} Photos can be sent by email.` } : c,
    );
    await step('index from empty', index, chunks, { embedded: chunks.length });
    await step('reindex unchanged', index, chunks, { unchanged: chunks.length, embedded: 0 });
    await step('edit one section', index, edited, { embedded: 1, unchanged: chunks.length - 1 });
    await step('revert the edit', index, chunks, { fromCache: 1, embedded: 0 });
    await step(
      'drop one section',
      index,
      chunks.filter((c) => c.id !== EDITED),
      { removed: 1, embedded: 0 },
    );
    await step('restore it', index, chunks, { fromCache: 1, embedded: 0 });

    const last = chunks.at(-1);
    if (last) await index.waitUntilSearchable(SCOPE, last);
    for (const query of QUERIES) {
      const matches = await index.search(SCOPE, query, 3);
      console.log(`\n"${query}"`);
      for (const m of matches) console.log(`  ${m.score.toFixed(3)}  ${m.id}`);
    }
  } finally {
    await client.close();
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
