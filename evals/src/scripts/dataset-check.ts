/**
 * Proves the labels of the agent eval dataset (Step 5.1). No model is involved.
 *   pnpm --filter @toolbridge/evals dataset:check            everything (needs MongoDB)
 *   pnpm --filter @toolbridge/evals dataset:check --static   only the checks without a host
 *   add --only m03,f01 to look at some cases
 * 1. Static: the labels agree with the compiled tools, the policy and the category's rules.
 * 2. Oracle replay: the case's own calls, as that role, on a freshly seeded host, must pass.
 * 3. Null agent: an agent that does nothing must fail every case that expects a tool call.
 * Exits with code 1 on any problem.
 */
import { parseArgs } from 'node:util';

import { CATEGORIES, type EvalCase, loadDataset } from '../dataset.js';
import { EvalHost } from '../host.js';
import { replayCase } from '../replay.js';
import { checkCase, checkSet } from '../static-check.js';
import { loadStoreTools, type StoreTools } from '../store-tools.js';
import { checkChanges, diffWorlds } from '../world.js';

const DATASET = 'evals/agent/host-store.json';

const { values: options } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { static: { type: 'boolean', default: false }, only: { type: 'string' } },
});

/** Replays every case, resetting the database only after a case that changed it. */
async function replayAll(cases: EvalCase[], store: StoreTools): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const host = await EvalHost.start(store);
  try {
    const seeded = await host.world();
    for (const c of cases) {
      const { problems, dirty } = await replayCase(c, host, store, seeded);
      found.set(c.id, problems);
      if (!dirty) continue;
      await host.reset();
      const rest = diffWorlds(seeded, await host.world());
      if (rest.length) throw new Error(`The reset after ${c.id} did not restore the seed.`);
    }
  } finally {
    await host.stop();
  }
  return found;
}

/**
 * True when doing nothing (no calls, no changes, an empty answer) already meets what code can
 * check. Such a case is only meaningful once its answer's wording is judged (Step 5.2).
 */
function nullAgentPasses(c: EvalCase): boolean {
  return checkChanges(c.changes, []).length === 0 && c.answer.mustInclude.length === 0;
}

/** Runs the checks, prints one table and the problems, and sets the exit code. */
async function main(): Promise<void> {
  const all = await loadDataset(DATASET);
  const store = await loadStoreTools();
  const only = options.only?.split(',');
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;

  const problems = [...(only ? [] : checkSet(all))];
  for (const c of cases) problems.push(...checkCase(c, store).map((p) => `${c.id} [static] ${p}`));
  console.log(
    `Static check: ${String(cases.length)} cases, ${String(problems.length)} problem(s).`,
  );

  const needTools = cases.filter((c) => c.steps.length > 0);
  const quiet = cases.filter(nullAgentPasses);
  const caughtByOutcome = needTools.filter((c) => !quiet.includes(c)).length;
  console.log(
    `Null agent: ${String(needTools.length)} cases need a tool call, so it fails them; ` +
      `${String(caughtByOutcome)} of those also fail on the outcome alone. ` +
      `Only the judge (5.2) can fail it on: ${quiet
        .filter((c) => c.steps.length === 0)
        .map((c) => c.id)
        .join(', ')}.`,
  );

  if (!options.static) {
    const started = performance.now();
    const replayed = await replayAll(cases, store);
    const failed = [...replayed].filter(([, list]) => list.length > 0);
    for (const [id, list] of failed) problems.push(...list.map((p) => `${id} [replay] ${p}`));
    const seconds = Math.round((performance.now() - started) / 1000);
    console.log(
      `Oracle replay: ${String(replayed.size - failed.length)} of ${String(replayed.size)} pass (${String(seconds)} s).`,
    );
  }

  console.table(
    Object.keys(CATEGORIES).map((category) => {
      const mine = cases.filter((c) => c.category === category);
      return {
        category,
        cases: mine.length,
        dev: mine.filter((c) => c.split === 'dev').length,
        test: mine.filter((c) => c.split === 'test').length,
        writes: mine.filter((c) => c.changes.length > 0).length,
      };
    }),
  );
  for (const problem of problems) console.log(`  - ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  console.log(
    problems.length === 0 ? 'All labels hold.' : `${String(problems.length)} problem(s).`,
  );
}

await main();
