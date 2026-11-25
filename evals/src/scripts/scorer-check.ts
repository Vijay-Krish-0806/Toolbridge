/**
 * Proves the runner and the scorer (Step 5.2), without a model: scripted good agents must pass and
 * scripted bad agents must fail, through the real graph, policy, approvals and host.
 *   pnpm --filter @toolbridge/evals scorer:check                      all agents (needs MongoDB)
 *   pnpm --filter @toolbridge/evals scorer:check --agent "extra write" --only m03
 * Exits with code 1 when any agent is scored differently than it must be.
 */
import { parseArgs } from 'node:util';

import { loadDataset } from '../dataset.js';
import { EvalHost } from '../host.js';
import { runCase } from '../run-case.js';
import { scoreRun } from '../score.js';
import { AGENTS, scriptedModel } from '../scripted-agents.js';
import { loadStoreTools } from '../store-tools.js';

const { values: options } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { agent: { type: 'string' }, only: { type: 'string' } },
});

/** Runs every agent on every case it is meant for and prints one line per agent. */
async function main(): Promise<void> {
  const cases = (await loadDataset('evals/agent/host-store.json')).filter(
    (c) => options.only?.split(',').includes(c.id) ?? true,
  );
  const store = await loadStoreTools();
  const writes = new Set(store.tools.filter((t) => t.safety === 'write').map((t) => t.name));
  const isWrite = (tool: string): boolean => writes.has(tool);
  const started = performance.now();
  let wrong = 0;
  const host = await EvalHost.start(store);
  try {
    const seeded = await host.world();
    for (const agent of AGENTS) {
      if (options.agent !== undefined && agent.name !== options.agent) continue;
      const mine = cases.filter((c) => agent.applies(c, isWrite));
      let passed = 0;
      const problems: string[] = [];
      for (const c of mine) {
        const llm = scriptedModel(agent, c, isWrite);
        const run = await runCase(c, llm, host, store, seeded, { limits: {}, timeoutMs: 60_000 });
        const score = scoreRun(c, run, store.tools);
        if (score.success) passed++;
        const problem = agent.expect(score, c);
        if (problem !== undefined) problems.push(`${c.id} ${problem}`);
      }
      wrong += problems.length;
      console.log(
        `${problems.length === 0 ? 'ok   ' : 'WRONG'} ${agent.name}: ${String(passed)} of ${String(mine.length)} cases succeed`,
      );
      for (const problem of problems) console.log(`        ${problem}`);
    }
  } finally {
    await host.stop();
  }
  const seconds = Math.round((performance.now() - started) / 1000);
  console.log(
    wrong === 0
      ? `The scorer holds (${String(seconds)} s).`
      : `${String(wrong)} wrong score(s) (${String(seconds)} s).`,
  );
  if (wrong > 0) process.exitCode = 1;
}

await main();
