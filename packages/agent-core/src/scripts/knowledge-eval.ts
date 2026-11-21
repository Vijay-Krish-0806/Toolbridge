/**
 * Step 3.3 acceptance: policy questions are answered with correct citations.
 *   pnpm --filter @toolbridge/agent-core knowledge:eval          print the report
 *   pnpm --filter @toolbridge/agent-core knowledge:eval --save   also write docs/results/knowledge-rag.{md,json}
 * Needs MongoDB, Ollama (chat and embedding models) and the host API (mixed questions look up
 * orders). Each question runs in a fresh conversation, with every generated tool plus
 * knowledge_search offered.
 *
 * Two layers, so a failure points at its cause:
 * 1. retrieval: is the expected section in the top k for the question itself? (no model)
 * 2. end to end: did the agent search, cite only what it retrieved (grounded), and cite the
 *    expected section (correct)? Questions the policies do not cover must get no citation.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadEmbeddingConfig, loadKnowledgeDir } from '@toolbridge/retrieval';
import { z } from 'zod';

import {
  checkCitations,
  citationWarning,
  passageIds,
  saysNotCovered,
  type CitationCheck,
} from '../agent/citations.js';
import { runAgent } from '../agent/loop.js';
import { storeAgentSystemPrompt } from '../agent/system-prompt.js';
import { loadLLMConfig } from '../config.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import { ToolExecutor } from '../tools/executor.js';
import { KNOWLEDGE_TOOL_NAME } from '../tools/knowledge-tool.js';
import { ToolRegistry } from '../tools/registry.js';
import { createGeneratedTools } from './generated-tools.js';
import { createKnowledge, KNOWLEDGE_SCOPE, PASSAGES_PER_SEARCH } from './knowledge-setup.js';

const EVAL_DB = 'toolbridge_knowledge_eval';
const root = resolve(import.meta.dirname, '../../../..');
const DATASET = 'evals/knowledge/host-store.json';
const KS = [1, 3, 5] as const;

const datasetSchema = z.object({
  queries: z.array(
    z.object({
      id: z.string(),
      q: z.string(),
      expect: z.array(z.array(z.string()).min(1)).min(1),
      tags: z.array(z.string()),
    }),
  ),
  notCovered: z.array(z.string()),
});
type Query = z.infer<typeof datasetSchema>['queries'][number];

interface RetrievalRow {
  id: string;
  /** Rank (1-based) at which every expect group had a match, or undefined beyond top 5. */
  hitRank: number | undefined;
  top: string[];
  topScore: number;
}

interface AgentRow {
  id: string;
  question: string;
  tags: string[];
  searched: boolean;
  citations: CitationCheck;
  /** In-domain: every expect group cited. Not covered: no citation and a "not covered" answer. */
  correct: boolean;
  grounded: boolean;
  /** The warning the chat would print for this answer, if any. */
  warning: string | undefined;
  stopReason: string;
  inputTokens: number;
  seconds: number;
  answer: string;
}

/** True when every expect group has at least one id in `ids`. */
const coversGroups = (expect: string[][], ids: string[]): boolean =>
  expect.every((group) => group.some((id) => ids.includes(id)));

/** The first 12 hex characters of a sha256, enough to tell versions apart in a report. */
const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`);

/**
 * Layer 1: searches each question directly and finds the rank at which it is fully covered.
 * Before -> after: k05 'A $15 vase arrived broken...' -> `{ hitRank: 1, top: ['refund-policy#damaged-items', ...] }`.
 */
async function evalRetrieval(
  index: Awaited<ReturnType<typeof createKnowledge>>['index'],
  queries: Query[],
): Promise<RetrievalRow[]> {
  const rows: RetrievalRow[] = [];
  for (const query of queries) {
    const matches = await index.search(KNOWLEDGE_SCOPE, query.q, 5);
    const ids = matches.map((m) => m.id);
    const rank = [1, 2, 3, 4, 5].find((k) => coversGroups(query.expect, ids.slice(0, k)));
    rows.push({
      id: query.id,
      hitRank: rank,
      top: ids.slice(0, 3),
      topScore: matches[0]?.score ?? 0,
    });
  }
  return rows;
}

/**
 * Layer 2: runs the agent once on a fresh conversation and grades its citations.
 * Before -> after: k01 -> `{ searched: true, citations: { cited: ['refund-policy#who-can-refund'], ... }, correct: true, grounded: true }`.
 */
async function evalAgent(
  agent: { llm: OpenAICompatibleProvider; registry: ToolRegistry; executor: ToolExecutor },
  item: { id: string; question: string; tags: string[]; expect?: string[][] },
): Promise<AgentRow> {
  const retrieved = new Set<string>();
  let searched = false;
  const started = performance.now();
  const run = await runAgent({
    ...agent,
    messages: [
      { role: 'system', content: storeAgentSystemPrompt({ knowledge: true }) },
      { role: 'user', content: item.question },
    ],
    onEvent: (event) => {
      if (event.type !== 'tool-end') return;
      if (event.call.name === KNOWLEDGE_TOOL_NAME) searched = true;
      for (const id of passageIds(event.call, event.result)) retrieved.add(id);
    },
  });
  const citations = checkCitations(run.answer, retrieved);
  const correct = item.expect
    ? coversGroups(item.expect, citations.grounded)
    : citations.cited.length === 0 && saysNotCovered(run.answer);
  return {
    id: item.id,
    question: item.question,
    tags: item.tags,
    searched,
    citations,
    correct,
    grounded: citations.ungrounded.length === 0,
    warning: citationWarning(citations, retrieved.size, run.answer),
    stopReason: run.stopReason,
    inputTokens: run.usage.inputTokens,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    answer: run.answer,
  };
}

/** Summary lines for one group of agent rows. */
function agentSummary(label: string, rows: AgentRow[]): string {
  const n = rows.length;
  const count = (f: (r: AgentRow) => boolean): number => rows.filter(f).length;
  const cited = rows.filter((r) => r.citations.cited.length > 0);
  return (
    `| ${label} | ${String(n)} | ${pct(
      count((r) => r.searched),
      n,
    )} | ${pct(
      count((r) => r.correct),
      n,
    )} | ` +
    `${pct(cited.filter((r) => r.grounded).length, cited.length)} (${String(cited.length)} cited) | ` +
    `${String(Math.round(rows.reduce((s, r) => s + r.inputTokens, 0) / Math.max(n, 1)))} |`
  );
}

/** The results as a markdown report. */
function toMarkdown(
  retrieval: RetrievalRow[],
  agentRows: AgentRow[],
  meta: Record<string, string>,
): string {
  const n = retrieval.length;
  const hitAt = (k: number): string =>
    pct(retrieval.filter((r) => r.hitRank !== undefined && r.hitRank <= k).length, n);
  const inDomain = agentRows.filter((r) => !r.tags.includes('not-covered'));
  const lines = [
    '# Knowledge RAG results (Step 3.3)',
    '',
    'Generated by `pnpm --filter @toolbridge/agent-core knowledge:eval --save`. Do not edit by hand.',
    '',
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    '## 1. Retrieval (question searched as written, no model)',
    '',
    `| questions | hit@${KS.join(' | hit@')} |`,
    `| --- | ${KS.map(() => '---').join(' | ')} |`,
    `| ${String(n)} | ${KS.map(hitAt).join(' | ')} |`,
    '',
    'Misses at k=3:',
    '',
    ...retrieval
      .filter((r) => r.hitRank === undefined || r.hitRank > 3)
      .map((r) => `- ${r.id}: got ${r.top.join(', ')}`),
    '',
    '## 2. End to end (agent with every generated tool plus knowledge_search)',
    '',
    '| set | questions | searched | correct | grounded citations | mean input tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    agentSummary(
      'policy',
      inDomain.filter((r) => r.tags.includes('policy')),
    ),
    agentSummary(
      'mixed',
      inDomain.filter((r) => r.tags.includes('mixed')),
    ),
    agentSummary(
      'not covered',
      agentRows.filter((r) => r.tags.includes('not-covered')),
    ),
    agentSummary('all', agentRows),
    '',
    '"correct": every expected section cited (from what was retrieved); for not-covered questions, no citation and an answer that says so. "grounded": every cited id was returned by knowledge_search in that run.',
    '',
    `Citation warning: shown on ${String(agentRows.filter((r) => !r.correct && r.warning).length)} of ${String(agentRows.filter((r) => !r.correct).length)} incorrect answers, and on ${String(agentRows.filter((r) => r.correct && r.warning).length)} correct ones (false alarms).`,
    '',
    '## Per question',
    '',
    '| id | searched | cited | correct | grounded | warned | s |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...agentRows.map(
      (r) =>
        `| ${r.id} | ${r.searched ? 'yes' : 'no'} | ${r.citations.cited.join(', ') || '-'} | ` +
        `${r.correct ? 'yes' : '**no**'} | ${r.grounded ? 'yes' : '**no**'} | ${r.warning ? 'yes' : '-'} | ${String(r.seconds)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** Runs both layers, prints the report, and saves it with --save. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { save: { type: 'boolean' } } });
  const raw = await readFile(resolve(root, DATASET), 'utf8');
  const dataset = datasetSchema.parse(JSON.parse(raw));
  const llmConfig = loadLLMConfig();
  const chunks = await loadKnowledgeDir(resolve(root, 'knowledge/host-store'));

  const knowledge = await createKnowledge(EVAL_DB);
  try {
    const retrieval = await evalRetrieval(knowledge.index, dataset.queries);
    const generated = await createGeneratedTools();
    const registry = new ToolRegistry([...generated.tools, knowledge.tool]);
    const agent = {
      llm: new OpenAICompatibleProvider(llmConfig),
      registry,
      executor: new ToolExecutor(registry),
    };
    const items = [
      ...dataset.queries.map((q) => ({ id: q.id, question: q.q, tags: q.tags, expect: q.expect })),
      ...dataset.notCovered.map((q, i) => ({
        id: `n${String(i + 1).padStart(2, '0')}`,
        question: q,
        tags: ['not-covered'],
      })),
    ];
    const agentRows: AgentRow[] = [];
    for (const item of items) {
      const row = await evalAgent(agent, item);
      agentRows.push(row);
      console.log(
        `${row.id}  ${row.correct ? 'ok  ' : 'MISS'}  searched=${String(row.searched)} ` +
          `cited=[${row.citations.cited.join(', ')}] ungrounded=[${row.citations.ungrounded.join(', ')}] ${String(row.seconds)}s`,
      );
    }

    const meta = {
      date: new Date().toISOString().slice(0, 10),
      'chat model': llmConfig.model,
      'embedding model': loadEmbeddingConfig().model,
      'passages per search': String(PASSAGES_PER_SEARCH),
      knowledge: `\`knowledge/host-store\` (${String(chunks.length)} chunks, sha256 \`${hash(JSON.stringify(chunks))}\`)`,
      dataset: `\`${DATASET}\` (sha256 \`${hash(raw)}\`)`,
    };
    const markdown = toMarkdown(retrieval, agentRows, meta);
    console.log(`\n${markdown}`);
    if (values.save === true) {
      const dir = resolve(root, 'docs/results');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'knowledge-rag.md'), markdown);
      await writeFile(
        resolve(dir, 'knowledge-rag.json'),
        `${JSON.stringify({ meta, retrieval, agent: agentRows }, null, 2)}\n`,
      );
      console.log('saved docs/results/knowledge-rag.{md,json}');
    }
  } finally {
    await knowledge.close();
  }
}

await main();
