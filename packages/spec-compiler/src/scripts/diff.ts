/**
 * Step 2.4: compares two versions of a spec and prints what changed, marking breaking changes.
 * Run with `pnpm --filter @toolbridge/spec-compiler diff <old> <new> [--fail-on-breaking]`.
 * With --fail-on-breaking the exit code is 1 when anything is breaking, so a CI pipeline can stop
 * a deploy that would break agents.
 */
import { resolve } from 'node:path';

import { diffModels, type Change } from '../diff.js';
import { contentHash } from '../hash.js';
import { loadSpec } from '../load.js';
import type { ApiModel } from '../model.js';
import { normalize } from '../normalize.js';

/** Resolves a file argument against the directory pnpm was run from; URLs pass through. */
function source(arg: string): string {
  return /^https?:\/\//i.test(arg) ? arg : resolve(process.env.INIT_CWD ?? process.cwd(), arg);
}

/** Loads and normalizes one version. */
async function load(arg: string): Promise<ApiModel> {
  return normalize(await loadSpec(source(arg))).model;
}

/** One printed line per change: `!` breaking, `·` safe. */
function line(change: Change): string {
  return `      ${change.breaking ? '! BREAKING' : '·'} ${change.message}`;
}

/** Loads both versions, diffs them, and prints a summary and every change. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const [oldArg, newArg] = files;
  if (oldArg === undefined || newArg === undefined) {
    console.error('Usage: diff <old-spec> <new-spec> [--fail-on-breaking]');
    process.exit(2);
  }
  const [before, after] = await Promise.all([load(oldArg), load(newArg)]);
  const diff = diffModels(before, after);
  const breakingOps = diff.changed.filter((c) => c.breaking).length;

  console.log(`${before.title} ${before.version} -> ${after.version}`);
  console.log(
    `  model hashes: ${contentHash(before).slice(0, 12)} -> ${contentHash(after).slice(0, 12)}`,
  );
  console.log(
    `  added ${String(diff.added.length)}, removed ${String(diff.removed.length)}, changed ${String(diff.changed.length)} (${String(breakingOps)} with breaking changes)`,
  );
  console.log(`  verdict: ${diff.breaking ? 'BREAKING' : 'compatible'}\n`);
  for (const op of diff.added) console.log(`  + ${op.method} ${op.path}  (${op.id})`);
  for (const op of diff.removed) console.log(`  - ${op.method} ${op.path}  (${op.id})  ! BREAKING`);
  for (const op of diff.changed) {
    console.log(`  ~ ${op.method} ${op.path}  (${op.id})${op.breaking ? '  ! BREAKING' : ''}`);
    for (const change of op.changes) console.log(line(change));
  }
  if (diff.breaking && args.includes('--fail-on-breaking')) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
