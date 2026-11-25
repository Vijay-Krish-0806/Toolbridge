/**
 * Runs the agent eval set on a real model and prints the scores (Step 5.2).
 *   pnpm --filter @toolbridge/evals eval:run                      every case, the model in .env
 *   pnpm --filter @toolbridge/evals eval:run --split dev --only s01,m03
 *   pnpm --filter @toolbridge/evals eval:run --model <ollama tag> --repeat 3
 *   pnpm --filter @toolbridge/evals eval:run --report             only score the saved runs again
 * Each run is appended to evals/logs/runs.jsonl with a FINGERPRINT of everything that could change
 * it, so a stopped eval continues where it was and old runs never mix with new code. Labels are
 * not part of it: saved runs are scored with the labels of now.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  loadLLMConfig,
  type LLMConfig,
  OpenAICompatibleProvider,
  storeAgentSystemPrompt,
} from '@toolbridge/agent-core';
import { z } from 'zod';

import { type EvalCase, loadDataset, root } from '../dataset.js';
import { EvalHost } from '../host.js';
import { renderReport, type ScoredRun } from '../report.js';
import { type CaseRun, runCase } from '../run-case.js';
import { scoreRun } from '../score.js';
import { loadStoreTools, type StoreTools } from '../store-tools.js';

const ROWS = resolve(root, 'evals/logs/runs.jsonl');
/** The platform's defaults (RUN_MAX_TOKENS, RUN_LEG_TIMEOUT_MS), so the agent is bounded alike. */
const MAX_RUN_TOKENS = 60_000;
const RUN_TIMEOUT_MS = 600_000;

interface Row {
  fingerprint: string;
  id: string;
  repeat: number;
  run: CaseRun;
}

const { values: options } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    model: { type: 'string' },
    split: { type: 'string' },
    only: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    report: { type: 'boolean', default: false },
  },
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A hash of the code that decides how a run goes: the agent, the policy, the spec compiler and the
 * runner. Tests and command-line scripts do not count.
 */
async function codeHash(): Promise<string> {
  const files = ['evals/src/run-case.ts', 'evals/src/host.ts'];
  for (const name of ['agent-core', 'policy', 'spec-compiler']) {
    const folder = `packages/${name}/src`;
    for (const file of await readdir(resolve(root, folder), { recursive: true })) {
      const path = file.replaceAll('\\', '/');
      if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.startsWith('scripts/'))
        files.push(`${folder}/${path}`);
    }
  }
  const texts = await Promise.all(
    files.sort().map(async (f) => `${f}\n${await readFile(resolve(root, f), 'utf8')}`),
  );
  return sha256(texts.join('\n').replaceAll('\r\n', '\n'));
}

/** The digest Ollama has for a model tag, so a re-created tag counts as another model. */
async function modelDigest(config: LLMConfig): Promise<string> {
  const response = await fetch(new URL('/api/tags', config.baseURL));
  const { models } = z
    .object({ models: z.array(z.object({ name: z.string(), digest: z.string() })) })
    .parse(await response.json());
  const found = models.find((m) => m.name === config.model || m.name === `${config.model}:latest`);
  if (!found) throw new Error(`Ollama has no model "${config.model}".`);
  return found.digest;
}

/** What a run of this case depends on: the setup, and the case's inputs (not its labels). */
function fingerprint(setup: string, c: EvalCase): string {
  return sha256(JSON.stringify([setup, c.role, c.question, c.approval])).slice(0, 16);
}

/** The rows of earlier runs, if any. */
async function loadRows(): Promise<Row[]> {
  try {
    const text = await readFile(ROWS, 'utf8');
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Row);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The cases this command is about. */
async function chosenCases(): Promise<EvalCase[]> {
  const only = options.only?.split(',');
  return (await loadDataset('evals/agent/host-store.json')).filter(
    (c) =>
      (options.split === undefined || c.split === options.split) && (only?.includes(c.id) ?? true),
  );
}

/** Runs what is missing, saving each run as soon as it is done. */
async function runMissing(
  work: { c: EvalCase; repeat: number; print: string }[],
  config: LLMConfig,
  store: StoreTools,
): Promise<Row[]> {
  const llm = new OpenAICompatibleProvider(config);
  const limits = {
    maxRunTokens: MAX_RUN_TOKENS,
    maxPromptTokens: config.contextLength - config.maxOutputTokens,
  };
  const rows: Row[] = [];
  await mkdir(dirname(ROWS), { recursive: true });
  const host = await EvalHost.start(store);
  try {
    const seeded = await host.world();
    for (const { c, repeat, print } of work) {
      const settings = { limits, timeoutMs: RUN_TIMEOUT_MS };
      const run = await runCase(c, llm, host, store, seeded, settings);
      const row = { fingerprint: print, id: c.id, repeat, run };
      await appendFile(ROWS, `${JSON.stringify(row)}\n`);
      rows.push(row);
      const { success, problems } = scoreRun(c, run, store.tools);
      console.log(
        `${c.id} #${String(repeat)} ${String(run.seconds)}s ${success ? 'ok' : `FAILED ${problems.join('; ')}`} [${run.attempts.map((a) => a.tool).join(', ')}]`,
      );
    }
  } finally {
    await host.stop();
  }
  return rows;
}

/** Runs the missing cases, then scores and prints everything. */
async function main(): Promise<void> {
  const base = loadLLMConfig();
  const config = { ...base, model: options.model ?? base.model };
  const repeats = z.coerce.number().int().min(1).max(10).parse(options.repeat);
  const cases = await chosenCases();
  const store = await loadStoreTools();
  const setup = JSON.stringify([
    await codeHash(),
    config.model,
    await modelDigest(config),
    config.contextLength,
    config.maxOutputTokens,
    storeAgentSystemPrompt({ knowledge: false }),
    sha256(JSON.stringify([store.tools, store.policy])),
  ]);

  const saved = await loadRows();
  const find = (print: string, repeat: number): Row | undefined =>
    saved.find((row) => row.fingerprint === print && row.repeat === repeat);
  const wanted = cases.flatMap((c) =>
    Array.from({ length: repeats }, (_, repeat) => ({ c, repeat, print: fingerprint(setup, c) })),
  );
  const missing = wanted.filter((w) => !find(w.print, w.repeat));
  console.log(
    `${config.model}: ${String(wanted.length)} runs wanted, ${String(wanted.length - missing.length)} saved.`,
  );
  if (!options.report && missing.length > 0)
    saved.push(...(await runMissing(missing, config, store)));

  const scored = wanted.flatMap(({ c, repeat, print }): ScoredRun[] => {
    const row = find(print, repeat);
    return row ? [{ case: c, run: row.run, score: scoreRun(c, row.run, store.tools) }] : [];
  });
  console.log(`\n${renderReport(`Agent eval: ${config.model}`, scored)}`);
}

await main();
