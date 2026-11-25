/** Totals over scored runs, as Markdown. Pure. */
import { CATEGORIES, type EvalCase } from './dataset.js';
import type { CaseRun } from './run-case.js';
import type { Score } from './score.js';

export interface ScoredRun {
  case: EvalCase;
  run: CaseRun;
  score: Score;
}

/**
 * The 95% Wilson interval of a share: where the true success rate plausibly lies, given few
 * cases. Unlike the simple formula it stays sensible near 0% and 100%.
 * Before -> after: `(8, 10)` -> `[0.49, 0.943]`.
 */
export function wilson(passed: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = passed / total;
  const base = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (center - spread) / base), Math.min(1, (center + spread) / base)];
}

/** Before -> after: `0.494` -> `'49%'`. */
const percent = (share: number): string => `${String(Math.round(share * 100))}%`;

/** Before -> after: `(8, 10)` -> `'8/10 (49-94%)'`; with no runs, `'-'`. */
function rate(passed: number, total: number): string {
  if (total === 0) return '-';
  const [low, high] = wilson(passed, total);
  return `${String(passed)}/${String(total)} (${percent(low)} to ${percent(high)})`;
}

/** The value at a share of the sorted list (nearest rank). Before -> after: `([3,1,2], 0.5)` -> `2`. */
function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

/** The sum of one number per run. */
function sum(runs: ScoredRun[], pick: (run: ScoredRun) => number): number {
  return runs.reduce((total, run) => total + pick(run), 0);
}

/** One table line about a group of runs. */
function groupLine(name: string, runs: ScoredRun[]): string {
  const passed = runs.filter((r) => r.score.success).length;
  const steps = sum(runs, (r) => r.score.steps);
  const tools = sum(runs, (r) => r.score.toolsRight);
  const args = sum(runs, (r) => r.score.argsRight);
  return (
    `| ${name} | ${rate(passed, runs.length)} | ${steps ? percent(tools / steps) : '-'} | ` +
    `${tools ? percent(args / tools) : '-'} | ${String(sum(runs, (r) => r.score.badWritesTried))} / ` +
    `${String(sum(runs, (r) => r.score.badWritesRun))} |`
  );
}

/** The report of one model's runs: scores per group, cost, and why cases failed. */
export function renderReport(title: string, runs: ScoredRun[]): string {
  const groups: [string, ScoredRun[]][] = [
    ['**all**', runs],
    ['dev', runs.filter((r) => r.case.split === 'dev')],
    ['test', runs.filter((r) => r.case.split === 'test')],
    ...Object.keys(CATEGORIES).map((category): [string, ScoredRun[]] => [
      category,
      runs.filter((r) => r.case.category === category),
    ]),
    ['decided by code', runs.filter((r) => !r.score.needsJudge)],
    ['needs the judge too', runs.filter((r) => r.score.needsJudge)],
  ];
  const seconds = runs.map((r) => r.run.seconds);
  const mean = (pick: (run: ScoredRun) => number): string =>
    String(Math.round(sum(runs, pick) / Math.max(1, runs.length)));
  const failed = runs.filter((r) => !r.score.success);
  return [
    `# ${title}`,
    '',
    'Success is the outcome after the run (ADR 0049), checked by code only. For the cases in the last line the wording is not judged yet, so their number is an upper bound.',
    '',
    '| Group | Success (95% interval) | Tools | Arguments | Unasked writes tried / run |',
    '| --- | --- | ---: | ---: | ---: |',
    ...groups.filter(([, list]) => list.length > 0).map(([name, list]) => groupLine(name, list)),
    '',
    `Tool calls: ${String(sum(runs, (r) => r.score.calls))} (reference: ${String(sum(runs, (r) => r.score.referenceCalls))}). ` +
      `Mean per run: ${mean((r) => r.run.inputTokens)} input tokens, ${mean((r) => r.run.outputTokens)} output tokens, ${mean((r) => r.run.llmCalls)} model calls. ` +
      `Seconds: p50 ${String(percentile(seconds, 0.5))}, p95 ${String(percentile(seconds, 0.95))}. ` +
      `Empty answers: ${String(runs.filter((r) => r.run.answer.trim() === '').length)}.`,
    '',
    ...(failed.length > 0 ? ['## Failed', ''] : []),
    ...failed.map((r) => `- ${r.case.id}: ${r.score.problems.join('; ')}`),
  ].join('\n');
}
