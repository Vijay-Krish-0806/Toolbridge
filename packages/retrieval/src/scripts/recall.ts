/**
 * Step 3.2: measures tool retrieval on labelled questions (evals/retrieval/*.json).
 *   pnpm --filter @toolbridge/retrieval recall              print the tables
 *   pnpm --filter @toolbridge/retrieval recall --save       also write docs/results/retrieval-baseline.{json,md}
 *   flags: --k 5 --k-fallback 15 --min-score 0.85          the selection policy to simulate
 *                                                           (defaults: DEFAULT_SELECTOR)
 * Needs MongoDB (pnpm infra:up), Ollama with the embedding model, and the GitHub spec in
 * .cache/public-specs/ (the dataset file says where to download it). Indexes into its own
 * database, so the embedding cache makes every run after the first fast.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { sha256, type ToolDefinition } from '@toolbridge/spec-compiler';
import { MongoClient } from 'mongodb';
import { z } from 'zod';

import { loadEmbeddingConfig } from '../config.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { ToolIndex, type ToolMatch } from '../tool-index.js';
import { DEFAULT_SELECTOR, type SelectorOptions, selectFromMatches } from '../tool-selector.js';
import { loadToolDataset, root, TOOL_DATASETS } from './eval-data.js';

const EVAL_DB = 'toolbridge_retrieval_eval';
const K_VALUES = [1, 3, 5, 10, 20];
const K_MAX = 20;
interface QueryResult {
  id: string;
  q: string;
  tags: string[];
  expect: string[][];
  /** 1-based rank of the best-ranked tool of each group, or null when not in the top K_MAX. */
  groupRanks: (number | null)[];
  top: ToolMatch[];
}

/** Share of a query's groups found in the top k (recall), and whether all were (hit). */
function scoreAt(result: QueryResult, k: number): { recall: number; hit: boolean } {
  const found = result.groupRanks.filter((rank) => rank !== null && rank <= k).length;
  return { recall: found / result.groupRanks.length, hit: found === result.groupRanks.length };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Value at quantile q (0..1) of a list, by nearest rank. */
function quantile(xs: number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/** Rough token count of tool definitions as the model receives them (chars / 4). */
function menuTokens(tools: ToolDefinition[]): number {
  const menu = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  return Math.round(JSON.stringify(menu).length / 4);
}

/** Runs one dataset: compile, index, search every question, and compute the tables. */
async function runDataset(
  file: string,
  db: ReturnType<MongoClient['db']>,
  policy: Omit<SelectorOptions, 'core'>,
) {
  const { raw, data, core, tools, specHash, labelNotes } = await loadToolDataset(file);

  const config = loadEmbeddingConfig();
  const index = new ToolIndex(db, new OllamaEmbeddingProvider(config));
  await index.ensureIndexes();
  const scope = { tenantId: 'eval', specId: data.spec };
  const started = performance.now();
  const reindex = await index.reindex(scope, tools);
  const indexMs = Math.round(performance.now() - started);
  const lastTool = tools.at(-1);
  if (lastTool) await index.waitUntilSearchable(scope, lastTool);

  const results: QueryResult[] = [];
  const searchMs: number[] = [];
  for (const query of data.queries) {
    const t0 = performance.now();
    const top = await index.search(scope, query.q, K_MAX);
    searchMs.push(performance.now() - t0);
    const rankOf = new Map(top.map((m, i) => [m.toolName, i + 1]));
    const groupRanks = query.expect.map((group) => {
      const ranks = group.map((name) => rankOf.get(name)).filter((r) => r !== undefined);
      return ranks.length ? Math.min(...ranks) : null;
    });
    results.push({
      id: query.id,
      q: query.q,
      tags: query.tags,
      expect: query.expect,
      groupRanks,
      top,
    });
  }
  const offTopicTop: number[] = [];
  for (const q of data.offTopic) offTopicTop.push((await index.search(scope, q, 1))[0]?.score ?? 0);

  const byTag = (tag?: string) => results.filter((r) => tag === undefined || r.tags.includes(tag));
  const table = (subset: QueryResult[]) =>
    K_VALUES.map((k) => ({
      k,
      recall: mean(subset.map((r) => scoreAt(r, k).recall)),
      hit: mean(subset.map((r) => (scoreAt(r, k).hit ? 1 : 0))),
    }));
  const tags = [...new Set(results.flatMap((r) => r.tags))];

  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const options: SelectorOptions = { ...policy, core };
  const selections = results.map((r) => {
    const selection = selectFromMatches(r.top, options);
    const offered = new Set(selection.names);
    const hit = r.expect.every((group) => group.some((name) => offered.has(name)));
    const definitions = selection.names
      .map((n) => toolByName.get(n))
      .filter((t) => t !== undefined);
    return {
      id: r.id,
      hit,
      mode: selection.mode,
      size: selection.names.length,
      tokens: menuTokens(definitions),
    };
  });

  return {
    spec: data.spec,
    dataset: { file, sha256: sha256(raw) },
    specHash,
    tools: tools.length,
    fullMenuTokens: menuTokens(tools),
    queries: results.length,
    reindex: { ...reindex, ms: indexMs },
    medianSearchMs: Math.round(quantile(searchMs, 0.5)),
    overall: table(results),
    byTag: Object.fromEntries(
      tags.map((tag) => [tag, { n: byTag(tag).length, table: table(byTag(tag)) }]),
    ),
    top1Scores: {
      inDomain: {
        min: Math.min(...results.map((r) => r.top[0]?.score ?? 0)),
        p10: quantile(
          results.map((r) => r.top[0]?.score ?? 0),
          0.1,
        ),
        median: quantile(
          results.map((r) => r.top[0]?.score ?? 0),
          0.5,
        ),
      },
      offTopic: { max: Math.max(...offTopicTop), median: quantile(offTopicTop, 0.5) },
    },
    policy: {
      ...options,
      hit: mean(selections.map((s) => (s.hit ? 1 : 0))),
      fallbackRate: mean(selections.map((s) => (s.mode === 'fallback' ? 1 : 0))),
      meanTools: mean(selections.map((s) => s.size)),
      meanTokens: Math.round(mean(selections.map((s) => s.tokens))),
      misses: selections.filter((s) => !s.hit).map((s) => s.id),
    },
    missesAt5: results
      .filter((r) => !scoreAt(r, 5).hit)
      .map((r) => ({
        id: r.id,
        q: r.q,
        expect: r.expect.map((g) => g.join(' | ')),
        groupRanks: r.groupRanks,
        top5: r.top.slice(0, 5).map((m) => `${m.toolName} ${m.score.toFixed(3)}`),
      })),
    labelNotes,
  };
}

type DatasetReport = Awaited<ReturnType<typeof runDataset>>;

/** The report as markdown: one section per spec. */
function toMarkdown(reports: DatasetReport[], meta: Record<string, string>): string {
  const lines = [
    '# Tool retrieval baseline (Step 3.2)',
    '',
    'Generated by `pnpm --filter @toolbridge/retrieval recall --save`. Do not edit by hand.',
    '',
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    "recall@k: share of a question's needed tools found in the top k. hit@k: share of questions with **all** needed tools in the top k. Token counts are rough (chars / 4).",
  ];
  for (const r of reports) {
    lines.push(
      '',
      `## ${r.spec}: ${String(r.tools)} tools, ${String(r.queries)} questions`,
      '',
      `Full menu: ~${String(r.fullMenuTokens)} tokens. Spec hash \`${r.specHash.slice(0, 12)}\`, dataset \`${r.dataset.file}\` (sha256 \`${r.dataset.sha256.slice(0, 12)}\`). Median search ${String(r.medianSearchMs)} ms.`,
      '',
      '| k | recall@k | hit@k |',
      '| --- | --- | --- |',
      ...r.overall.map((row) => `| ${String(row.k)} | ${pct(row.recall)} | ${pct(row.hit)} |`),
      '',
      '| tag | n | hit@1 | hit@3 | hit@5 | hit@10 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...Object.entries(r.byTag).map(
        ([tag, { n, table }]) =>
          `| ${tag} | ${String(n)} | ${table
            .filter((row) => row.k <= 10)
            .map((row) => pct(row.hit))
            .join(' | ')} |`,
      ),
      '',
      `Top-1 score, labelled questions: min ${r.top1Scores.inDomain.min.toFixed(3)}, p10 ${r.top1Scores.inDomain.p10.toFixed(3)}, median ${r.top1Scores.inDomain.median.toFixed(3)}. Off-topic: max ${r.top1Scores.offTopic.max.toFixed(3)}, median ${r.top1Scores.offTopic.median.toFixed(3)}.`,
      '',
      `**Policy** (k ${String(r.policy.k)}, fallback ${String(r.policy.kFallback)} below ${String(r.policy.minTopScore)}, core [${r.policy.core.join(', ')}]): hit ${pct(r.policy.hit)}, fallback on ${pct(r.policy.fallbackRate)} of questions, ${r.policy.meanTools.toFixed(1)} tools and ~${String(r.policy.meanTokens)} tokens per menu on average. Misses: ${r.policy.misses.join(', ') || 'none'}.`,
      '',
      'Misses at k=5:',
      '',
      ...(r.missesAt5.length
        ? r.missesAt5.map(
            (m) =>
              `- ${m.id} "${m.q}": needs ${m.expect.map((g) => `[${g}]`).join(' + ')}, ranks ${JSON.stringify(m.groupRanks)}; got ${m.top5.join(', ')}`,
          )
        : ['- none']),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Runs both datasets, prints the report, and saves it with --save. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      save: { type: 'boolean' },
      k: { type: 'string', default: String(DEFAULT_SELECTOR.k) },
      'k-fallback': { type: 'string', default: String(DEFAULT_SELECTOR.kFallback) },
      'min-score': { type: 'string', default: String(DEFAULT_SELECTOR.minTopScore) },
    },
  });
  const policy = {
    k: Number(values.k),
    kFallback: Number(values['k-fallback']),
    minTopScore: Number(values['min-score']),
  };
  const { MONGO_URI } = z.object({ MONGO_URI: z.string().min(1) }).parse(process.env);
  const config = loadEmbeddingConfig();
  const client = await MongoClient.connect(MONGO_URI);
  const reports: DatasetReport[] = [];
  try {
    for (const file of TOOL_DATASETS) {
      reports.push(await runDataset(file, client.db(EVAL_DB), policy));
    }
  } finally {
    await client.close();
  }
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    'embedding model': `${config.model}, ${String(config.dimensions)} dimensions`,
    'query instruction': config.queryInstruction ? `"${config.queryInstruction}"` : 'none',
    'tool text': 'name + description + arguments (Step 3.1 buildToolText)',
    datasets:
      'hand-written by Claude Code, see the "about" field of each file (possible optimistic bias)',
  };
  const markdown = toMarkdown(reports, meta);
  console.log(markdown);
  for (const r of reports) {
    console.log(`${r.spec} reindex: ${JSON.stringify(r.reindex)}`);
    for (const note of r.labelNotes) console.log(`  label note: ${note}`);
  }
  if (values.save === true) {
    const dir = resolve(root, 'docs/results');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'retrieval-baseline.md'), markdown);
    await writeFile(
      resolve(dir, 'retrieval-baseline.json'),
      `${JSON.stringify({ meta, reports }, null, 2)}\n`,
    );
    console.log('Saved docs/results/retrieval-baseline.{md,json}');
  }
}

await main();
