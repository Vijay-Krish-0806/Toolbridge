/**
 * Compares the two agent engines (raw loop vs LangGraph) for ADR 0025. Not a test.
 *   pnpm --filter @toolbridge/agent-core engines:compare          print the report
 *   pnpm --filter @toolbridge/agent-core engines:compare --save   also write
 *     docs/results/engines-compare.{md,json}
 *   add --overhead-only to skip the live part (no model or host needed)
 *
 * Part 1, framework overhead: the same scripted run (one tool call, then an answer) on the fake
 * model, many times. No model or network time is in it, so the difference is the engine's own cost.
 * Part 2, live behavior: a few READ-ONLY questions on the real model and host API, each run on
 * both engines. Read-only so the first engine cannot change data the second one then sees.
 * The local model is not fully deterministic, so a different tool sequence can be model
 * variance, not the engine: the report says so instead of hiding it.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { ENGINES, type AgentEngine, type EngineName } from '../agent/engines.js';
import type { AgentRunResult } from '../agent/run-types.js';
import { storeAgentSystemPrompt } from '../agent/system-prompt.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { FakeProvider } from '../llm/fake-provider.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { GenerateResult } from '../llm/types.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { defineTool } from '../tools/tool.js';

const RESULTS = new URL('../../../../docs/results/', import.meta.url);
const OVERHEAD_RUNS = 300;
const WARMUP_RUNS = 30;
const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[];

/** Read-only questions covering: one tool, two chained tools, a list, an error, and no tool. */
const QUESTIONS = [
  'What is the status of order ORD-10007?',
  'Who placed order ORD-10031? Give me their name and email.',
  'List the 3 most recent orders.',
  'Which products are in the catalog? Just give me the first five names.',
  'Show me order ORD-99999.',
  'Hi! What can you help me with?',
];

interface OverheadRow {
  engine: EngineName;
  runs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

interface LiveRow {
  question: string;
  engine: EngineName;
  tools: string[];
  stopReason: AgentRunResult['stopReason'];
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  answerChars: number;
}

/**
 * The value at fraction `q` of the sorted list (nearest rank).
 * Before -> after: `([1, 2, 3, 4], 0.5)` -> `2`.
 */
function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

/** Rounds to 3 decimals, for milliseconds in the report. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Times one engine on the fake model: a tool call, then an answer, with a no-op tool. Warm-up
 * runs come first and are not counted (they pay for JIT compilation and the graph's first build).
 */
async function measureOverhead(name: EngineName, engine: AgentEngine): Promise<OverheadRow> {
  const tool = defineTool({
    name: 'orders_get',
    description: 'noop',
    safety: 'read',
    input: z.object({}),
    execute: () => Promise.resolve({ ok: true }),
  });
  const registry = new ToolRegistry([tool]);
  const executor = new ToolExecutor(registry);
  const script: GenerateResult[] = [
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'orders_get', arguments: '{}' }],
      },
      finishReason: 'tool_calls',
    },
    { message: { role: 'assistant', content: 'done', toolCalls: [] }, finishReason: 'stop' },
  ];

  const times: number[] = [];
  for (let i = 0; i < WARMUP_RUNS + OVERHEAD_RUNS; i++) {
    const started = performance.now();
    await engine({
      llm: new FakeProvider(script),
      registry,
      executor,
      messages: [{ role: 'user', content: 'q' }],
    });
    if (i >= WARMUP_RUNS) times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
  return {
    engine: name,
    runs: times.length,
    meanMs: round3(mean),
    p50Ms: round3(percentile(times, 0.5)),
    p95Ms: round3(percentile(times, 0.95)),
  };
}

/** Runs every question on every engine against the real model and host API. */
async function measureLive(): Promise<LiveRow[]> {
  const llm = new OpenAICompatibleProvider(loadLLMConfig());
  const registry = new ToolRegistry(createHostStoreTools(new HostApiClient(loadHostApiConfig())));
  const executor = new ToolExecutor(registry);
  const system = { role: 'system' as const, content: storeAgentSystemPrompt({ knowledge: false }) };
  const rows: LiveRow[] = [];

  for (const question of QUESTIONS) {
    for (const engine of ENGINE_NAMES) {
      const tools: string[] = [];
      const started = performance.now();
      const run = await ENGINES[engine]({
        llm,
        registry,
        executor,
        messages: [system, { role: 'user', content: question }],
        onEvent: (event) => {
          if (event.type === 'tool-start') tools.push(event.call.name);
        },
      });
      const row: LiveRow = {
        question,
        engine,
        tools,
        stopReason: run.stopReason,
        llmCalls: run.usage.llmCalls,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        answerChars: run.answer.length,
      };
      console.log(
        `  ${engine.padEnd(5)} ${row.seconds.toFixed(1).padStart(5)}s  ${row.stopReason}  [${tools.join(', ')}]  ${question}`,
      );
      rows.push(row);
    }
  }
  return rows;
}

/** Renders both parts as a Markdown report. */
function toMarkdown(overhead: OverheadRow[], live: LiveRow[], model: string | undefined): string {
  const lines = [
    '# Agent engines: raw loop vs LangGraph',
    '',
    `Generated by \`pnpm --filter @toolbridge/agent-core engines:compare --save\` on ${new Date().toISOString().slice(0, 10)}. See ADR 0025.`,
    '',
    '## Framework overhead (fake model, no network)',
    '',
    `One tool call then an answer, ${String(OVERHEAD_RUNS)} runs per engine after ${String(WARMUP_RUNS)} warm-up runs.`,
    '',
    '| Engine | Mean ms | p50 ms | p95 ms |',
    '| --- | ---: | ---: | ---: |',
    ...overhead.map(
      (r) => `| ${r.engine} | ${String(r.meanMs)} | ${String(r.p50Ms)} | ${String(r.p95Ms)} |`,
    ),
  ];
  if (live.length > 0) {
    lines.push(
      '',
      `## Live behavior (${model ?? 'local model'}, hand-written host tools, read-only questions)`,
      '',
      'A different tool sequence between engines can be model variance: the local model is not fully deterministic.',
      '',
      '| Question | Engine | Tools called | Stop | LLM calls | Tokens in/out | Seconds |',
      '| --- | --- | --- | --- | ---: | ---: | ---: |',
      ...live.map(
        (r) =>
          `| ${r.question} | ${r.engine} | ${r.tools.join(', ') || '(none)'} | ${r.stopReason} | ${String(r.llmCalls)} | ${String(r.inputTokens)}/${String(r.outputTokens)} | ${r.seconds.toFixed(1)} |`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Runs part 1, then part 2 unless --overhead-only, prints the report and saves it with --save. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { save: { type: 'boolean' }, 'overhead-only': { type: 'boolean' } },
  });
  console.log('Part 1: framework overhead (fake model)');
  const overhead: OverheadRow[] = [];
  for (const name of ENGINE_NAMES) overhead.push(await measureOverhead(name, ENGINES[name]));

  let live: LiveRow[] = [];
  let model: string | undefined;
  if (values['overhead-only'] !== true) {
    model = loadLLMConfig().model;
    console.log(`Part 2: live behavior on ${model}`);
    live = await measureLive();
  }

  const report = toMarkdown(overhead, live, model);
  console.log(`\n${report}`);
  if (values.save === true) {
    await writeFile(new URL('engines-compare.md', RESULTS), report);
    await writeFile(
      new URL('engines-compare.json', RESULTS),
      `${JSON.stringify({ model, overhead, live }, null, 2)}\n`,
    );
    console.log('Saved docs/results/engines-compare.{md,json}');
  }
}

await main();
