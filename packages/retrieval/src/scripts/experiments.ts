/**
 * Step 3.4: retrieval experiments, scored on the same labelled questions as the baselines.
 *   pnpm --filter @toolbridge/retrieval experiments          print the table
 *   pnpm --filter @toolbridge/retrieval experiments --save   also write docs/results/retrieval-experiments.{md,json}
 * Needs MongoDB, Ollama (embedding and chat models) and the GitHub spec in .cache/public-specs/.
 *
 * Variants (all return the top 20 per question):
 *   vector            the Step 3.1/3.3 baseline
 *   keyword           BM25 only (a diagnostic: how much do exact words carry?)
 *   hybrid            vector + BM25, merged with RRF
 *   rewrite+vector    the model expands the question first, then vector search
 *   rewrite+hybrid    the same, then hybrid search
 *   rerank(vector)    the model reorders the vector top 20
 *   rerank(hybrid)    the model reorders the hybrid top 20
 *
 * The decision rule is fixed here, before the first run (see ADR 0024), and applied by the script.
 * Work is grouped by model (all searches, then all rewrites, then all reranks) so Ollama does not
 * swap the embedding and chat models on every question.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MongoClient } from 'mongodb';
import { z } from 'zod';

import { loadEmbeddingConfig } from '../config.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { buildChunkText } from '../knowledge/chunker.js';
import { KnowledgeIndex } from '../knowledge/knowledge-index.js';
import { loadKnowledgeDir } from '../knowledge/load.js';
import { OllamaJson } from '../query/ollama-json.js';
import { type Candidate, rerank } from '../query/rerank.js';
import { expandQuery, type RewriteTarget } from '../query/rewrite.js';
import type { SearchMode } from '../tool-index.js';
import { ToolIndex } from '../tool-index.js';
import { waitFor } from '../vector-index.js';
import { loadToolDataset, root, TOOL_DATASETS } from './eval-data.js';

const DEPTH = 20;
const KS = [1, 3, 5] as const;
const VARIANTS = [
  'vector',
  'keyword',
  'hybrid',
  'rewrite+vector',
  'rewrite+hybrid',
  'rerank(vector)',
  'rerank(hybrid)',
] as const;
type Variant = (typeof VARIANTS)[number];

/**
 * The decision rule, fixed before running. A variant is kept when, against `vector`:
 * - it gains at least MIN_GAIN questions (at each dataset's key k) on at least 2 of 3 datasets,
 * - it loses at most MAX_LOSS questions on any dataset, and
 * - if it adds more than SLOW_MS median latency per question (a model call), it gains at least
 *   MIN_GAIN_SLOW questions on at least 2 datasets: seconds per message must buy a clear win.
 */
const RULE = { MIN_GAIN: 2, MAX_LOSS: 1, SLOW_MS: 1000, MIN_GAIN_SLOW: 4 };

interface Item {
  id: string;
  q: string;
  expect: string[][];
}

interface Dataset {
  name: string;
  target: RewriteTarget;
  /** The k the decision uses: 5 for tool menus (Step 3.2 policy), 3 for policy passages. */
  keyK: number;
  items: Item[];
  search: (query: string, k: number, mode: SearchMode) => Promise<Candidate[]>;
  hash: string;
}

interface Run {
  ranked: string[];
  ms: number;
}

const POLICY_DATASET = 'evals/knowledge/host-store.json';
const policyDataset = z.object({
  queries: z.array(
    z.object({ id: z.string(), q: z.string(), expect: z.array(z.array(z.string()).min(1)).min(1) }),
  ),
});

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** 1-based rank at which every expect group has a match, or undefined beyond the list. */
function hitRank(expect: string[][], ranked: string[]): number | undefined {
  const ranks = expect.map((group) => {
    const found = group.map((id) => ranked.indexOf(id)).filter((i) => i >= 0);
    return found.length ? Math.min(...found) + 1 : undefined;
  });
  return ranks.every((r) => r !== undefined) ? Math.max(...ranks) : undefined;
}

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) : 0;
};

/** Times one async call. */
async function timed<T>(f: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t0 };
}

/** Indexes the two tool datasets and the policies, and returns them with a search function each. */
async function loadDatasets(client: MongoClient): Promise<Dataset[]> {
  const provider = new OllamaEmbeddingProvider(loadEmbeddingConfig());
  const datasets: Dataset[] = [];

  const tools = new ToolIndex(client.db('toolbridge_retrieval_eval'), provider);
  await tools.ensureIndexes();
  for (const file of TOOL_DATASETS) {
    const { raw, data, tools: defs } = await loadToolDataset(file);
    const scope = { tenantId: 'eval', specId: data.spec };
    console.log(`${data.spec} reindex: ${JSON.stringify(await tools.reindex(scope, defs))}`);
    const last = defs.at(-1);
    if (last) {
      await tools.waitUntilSearchable(scope, last);
      await waitFor(
        async () =>
          (await tools.search(scope, last.name.replace(/_/g, ' '), 20, 'keyword')).some(
            (m) => m.toolName === last.name,
          ),
        `Keyword index for ${last.name}`,
      );
    }
    datasets.push({
      name: data.spec,
      target: 'tools',
      keyK: 5,
      items: data.queries.map((q) => ({ id: q.id, q: q.q, expect: q.expect })),
      search: async (query, k, mode) =>
        (await tools.search(scope, query, k, mode)).map((m) => ({ id: m.toolName, text: m.text })),
      hash: hash(raw),
    });
  }

  const knowledge = new KnowledgeIndex(client.db('toolbridge_knowledge_eval'), provider);
  await knowledge.ensureIndexes();
  const chunks = await loadKnowledgeDir(resolve(root, 'knowledge/host-store'));
  const scope = { tenantId: 'local', source: 'host-store' };
  console.log(`policies reindex: ${JSON.stringify(await knowledge.reindex(scope, chunks))}`);
  const lastChunk = chunks.at(-1);
  if (lastChunk) {
    await knowledge.waitUntilSearchable(scope, lastChunk);
    await waitFor(
      async () =>
        (await knowledge.search(scope, lastChunk.text, 20, 'keyword')).some(
          (m) => m.id === lastChunk.id,
        ),
      `Keyword index for ${lastChunk.id}`,
    );
  }
  const raw = await readFile(resolve(root, POLICY_DATASET), 'utf8');
  const policyData = policyDataset.parse(JSON.parse(raw));
  datasets.push({
    name: 'policies',
    target: 'policies',
    keyK: 3,
    items: policyData.queries,
    search: async (query, k, mode) =>
      (await knowledge.search(scope, query, k, mode)).map((m) => ({
        id: m.id,
        text: buildChunkText(m),
      })),
    hash: hash(raw),
  });
  return datasets;
}

interface Result {
  dataset: Dataset;
  runs: Record<Variant, Run[]>;
  rewrites: string[];
}

/** Runs every variant on every question of every dataset. */
async function runAll(datasets: Dataset[], llm: OllamaJson): Promise<Result[]> {
  // 1. Embedding model only: the three plain searches, keeping candidates for reranking.
  const plain = [];
  for (const d of datasets) {
    const runs = { vector: [] as Run[], keyword: [] as Run[], hybrid: [] as Run[] };
    const firstStage = { vector: [] as Candidate[][], hybrid: [] as Candidate[][] };
    for (const mode of ['vector', 'keyword', 'hybrid'] as const) {
      for (const item of d.items) {
        const { value, ms } = await timed(() => d.search(item.q, DEPTH, mode));
        runs[mode].push({ ranked: value.map((c) => c.id), ms });
        if (mode !== 'keyword') firstStage[mode].push(value);
      }
    }
    console.log(`${d.name}: searches done`);
    plain.push({ d, runs, firstStage });
  }
  // 2. Chat model only: rewrite every question.
  const expanded = [];
  for (const p of plain) {
    const queries: { text: string; ms: number }[] = [];
    for (const item of p.d.items) {
      const { value, ms } = await timed(() => expandQuery(llm, item.q, p.d.target));
      queries.push({ text: value, ms });
    }
    const ms = Math.round(median(queries.map((q) => q.ms)));
    console.log(`${p.d.name}: rewrites done (median ${String(ms)} ms)`);
    expanded.push({ ...p, queries });
  }
  // 3. Embedding model again: search with the rewritten queries (latency includes the rewrite).
  const rewritten = [];
  for (const e of expanded) {
    const runs = { 'rewrite+vector': [] as Run[], 'rewrite+hybrid': [] as Run[] };
    for (const mode of ['vector', 'hybrid'] as const) {
      for (const query of e.queries) {
        const { value, ms } = await timed(() => e.d.search(query.text, DEPTH, mode));
        runs[`rewrite+${mode}`].push({ ranked: value.map((c) => c.id), ms: ms + query.ms });
      }
    }
    rewritten.push({ ...e, rewriteRuns: runs });
  }
  // 4. Chat model again: rerank the plain candidates (latency includes the first search).
  const results: Result[] = [];
  for (const r of rewritten) {
    const runs = { 'rerank(vector)': [] as Run[], 'rerank(hybrid)': [] as Run[] };
    for (const mode of ['vector', 'hybrid'] as const) {
      for (const [i, item] of r.d.items.entries()) {
        const first = r.firstStage[mode][i] ?? [];
        const { value, ms } = await timed(() => rerank(llm, item.q, first, r.d.target));
        const searchMs = r.runs[mode][i]?.ms ?? 0;
        runs[`rerank(${mode})`].push({ ranked: value.map((c) => c.id), ms: ms + searchMs });
      }
      console.log(`${r.d.name}: rerank(${mode}) done`);
    }
    results.push({
      dataset: r.d,
      runs: { ...r.runs, ...r.rewriteRuns, ...runs },
      rewrites: r.queries.map((q) => q.text),
    });
  }
  return results;
}

interface Score {
  hits: Record<number, number>;
  medianMs: number;
  /** Question ids that hit at the key k, for the gained/lost lists. */
  hitIds: Set<string>;
}

/** hit@k counts and latency for one variant on one dataset. */
function score(d: Dataset, runs: Run[]): Score {
  const hits: Record<number, number> = {};
  const hitIds = new Set<string>();
  d.items.forEach((item, i) => {
    const rank = hitRank(item.expect, runs[i]?.ranked ?? []);
    for (const k of KS) if (rank !== undefined && rank <= k) hits[k] = (hits[k] ?? 0) + 1;
    if (rank !== undefined && rank <= d.keyK) hitIds.add(item.id);
  });
  return { hits, medianMs: median(runs.map((r) => r.ms)), hitIds };
}

interface Comparison {
  variant: Variant;
  /** Per dataset, in order: questions gained and lost at the key k, against vector. */
  gained: string[][];
  lost: string[][];
  /** The largest added median latency over the datasets. */
  addedMs: number;
}

/**
 * Compares one variant with the vector baseline on every dataset.
 * Before -> after: hybrid -> `{ gained: [['h20'], ['g07', 'g12'], ['k12']], lost: [[], [], []], addedMs: 30 }`.
 */
function compare(variant: Variant, scored: { dataset: Dataset; scores: Record<Variant, Score> }[]) {
  const comparison: Comparison = { variant, gained: [], lost: [], addedMs: 0 };
  for (const { scores } of scored) {
    const base = scores.vector;
    const s = scores[variant];
    comparison.gained.push([...s.hitIds].filter((id) => !base.hitIds.has(id)));
    comparison.lost.push([...base.hitIds].filter((id) => !s.hitIds.has(id)));
    comparison.addedMs = Math.max(comparison.addedMs, s.medianMs - base.medianMs);
  }
  return comparison;
}

/**
 * Applies RULE to one comparison.
 * Before -> after: gains [3, 0, 2], losses [0, 1, 0], +40 ms ->
 * `{ keep: true, reason: 'gains >= 2 on 2 datasets, losses <= 1' }`.
 */
function decide(c: Comparison): { keep: boolean; reason: string } {
  const slow = c.addedMs > RULE.SLOW_MS;
  const need = slow ? RULE.MIN_GAIN_SLOW : RULE.MIN_GAIN;
  const winning = c.gained.filter((g) => g.length >= need).length;
  const worstLoss = Math.max(...c.lost.map((l) => l.length));
  if (worstLoss > RULE.MAX_LOSS) {
    return { keep: false, reason: `loses ${String(worstLoss)} questions on one dataset` };
  }
  if (winning < 2) {
    const why = slow ? ' (adds a model call, so it needs a clear win)' : '';
    return {
      keep: false,
      reason: `gains >= ${String(need)} on only ${String(winning)} dataset(s)${why}`,
    };
  }
  return {
    keep: true,
    reason: `gains >= ${String(need)} on ${String(winning)} datasets, losses <= ${String(RULE.MAX_LOSS)}`,
  };
}

/** The report as markdown. */
function toMarkdown(
  scored: { dataset: Dataset; scores: Record<Variant, Score> }[],
  meta: Record<string, string>,
): string {
  const head = scored.map(
    ({ dataset: d }) => `${d.name} hit@${String(d.keyK)} (n=${String(d.items.length)})`,
  );
  const lines = [
    '# Retrieval experiments (Step 3.4)',
    '',
    'Generated by `pnpm --filter @toolbridge/retrieval experiments --save`. Do not edit by hand.',
    '',
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    `Decision rule (fixed before the first run): keep a variant if, against \`vector\`, it gains at least ${String(RULE.MIN_GAIN)} questions at the key k on at least 2 of 3 datasets and loses at most ${String(RULE.MAX_LOSS)} on any; if it adds more than ${String(RULE.SLOW_MS)} ms median per question, it must gain at least ${String(RULE.MIN_GAIN_SLOW)}. Key k: hit@5 for tools, hit@3 for policies.`,
    '',
    '## Before and after',
    '',
    `| variant | ${head.join(' | ')} | added ms (median) | keep? |`,
    `| --- | ${head.map(() => '---').join(' | ')} | --- | --- |`,
  ];
  const reasons: string[] = [];
  for (const v of VARIANTS) {
    const c = compare(v, scored);
    const cells = scored.map(({ scores }, i) => {
      const n = String(scores[v].hitIds.size);
      return v === 'vector'
        ? n
        : `${n} (+${String(c.gained[i]?.length ?? 0)} / -${String(c.lost[i]?.length ?? 0)})`;
    });
    let verdict = 'baseline';
    if (v === 'keyword') verdict = 'diagnostic only';
    else if (v !== 'vector') {
      const d = decide(c);
      verdict = d.keep ? '**yes**' : 'no';
      const changes = scored.map(
        ({ dataset }, i) =>
          `${dataset.name}: gained [${(c.gained[i] ?? []).join(', ')}], lost [${(c.lost[i] ?? []).join(', ')}]`,
      );
      reasons.push(`- **${v}:** ${d.reason}. ${changes.join('; ')}.`);
    }
    const added = v === 'vector' ? '-' : String(Math.round(c.addedMs));
    lines.push(`| ${v} | ${cells.join(' | ')} | ${added} | ${verdict} |`);
  }
  lines.push('', '## hit@1 / hit@3 / hit@5 per dataset', '');
  for (const { dataset, scores } of scored) {
    lines.push(
      `### ${dataset.name}`,
      '',
      '| variant | hit@1 | hit@3 | hit@5 | median ms |',
      '| --- | --- | --- | --- | --- |',
      ...VARIANTS.map(
        (v) =>
          `| ${v} | ${KS.map((k) => String(scores[v].hits[k] ?? 0)).join(' | ')} | ${String(Math.round(scores[v].medianMs))} |`,
      ),
      '',
    );
  }
  lines.push('## Reasons and changed questions', '', ...reasons);
  return `${lines.join('\n')}\n`;
}

/** Runs everything, prints the report, and saves it with --save. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { save: { type: 'boolean' } } });
  const env = z
    .object({
      MONGO_URI: z.string().min(1),
      LLM_MODEL: z.string().default('toolbridge-qwen3.5-4b-16k'),
    })
    .parse(process.env);
  const embedding = loadEmbeddingConfig();
  const llm = new OllamaJson({ baseUrl: embedding.baseUrl, model: env.LLM_MODEL });
  const client = await MongoClient.connect(env.MONGO_URI);
  try {
    const results = await runAll(await loadDatasets(client), llm);
    const scored = results.map((r) => ({
      dataset: r.dataset,
      scores: Object.fromEntries(VARIANTS.map((v) => [v, score(r.dataset, r.runs[v])])) as Record<
        Variant,
        Score
      >,
    }));
    const meta = {
      date: new Date().toISOString().slice(0, 10),
      'embedding model': embedding.model,
      'chat model (rewrite, rerank)': `${env.LLM_MODEL}, temperature 0, seed 42, thinking off`,
      fusion:
        'Reciprocal Rank Fusion, constant 60, top 20 from each side, in code ($rankFusion is disabled on Atlas Local 8.0.34)',
      datasets: results.map((r) => `${r.dataset.name} (sha256 \`${r.dataset.hash}\`)`).join(', '),
      bias: "all questions written by Claude Code; no held-out set (Vijay's call for now)",
    };
    const markdown = toMarkdown(scored, meta);
    console.log(`\n${markdown}`);
    if (values.save === true) {
      const dir = resolve(root, 'docs/results');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'retrieval-experiments.md'), markdown);
      const perQuestion = results.map((r) => ({
        dataset: r.dataset.name,
        questions: r.dataset.items.map((item, i) => ({
          id: item.id,
          q: item.q,
          rewrite: r.rewrites[i],
          top5: Object.fromEntries(VARIANTS.map((v) => [v, r.runs[v][i]?.ranked.slice(0, 5)])),
        })),
      }));
      await writeFile(
        resolve(dir, 'retrieval-experiments.json'),
        `${JSON.stringify({ meta, rule: RULE, perQuestion }, null, 2)}\n`,
      );
      console.log('saved docs/results/retrieval-experiments.{md,json}');
    }
  } finally {
    await client.close();
  }
}

await main();
