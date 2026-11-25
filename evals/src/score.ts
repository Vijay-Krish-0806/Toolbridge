/**
 * Scores one run of one case. Pure: the same case and run always give the same score, so saved
 * runs can be scored again when a label or a rule changes.
 *
 * Success is the OUTCOME (ADR 0049). Which tools were used, and with which arguments, are separate
 * scores: several paths can be right.
 */
import type { ToolDefinition } from '@toolbridge/spec-compiler';

import type { EvalCall, EvalCase } from './dataset.js';
import type { Attempt, CaseRun } from './run-case.js';
import { checkChanges } from './world.js';

export interface Score {
  /** Every check that code can make passed. */
  success: boolean;
  /** Why not. */
  problems: string[];
  /** The wording still has to be judged: the case asks for a question back, a refusal, "no data". */
  needsJudge: boolean;
  /** Steps whose tool was called, and how many steps there are. */
  toolsRight: number;
  steps: number;
  /** Of the steps whose tool was called: those with the right arguments. */
  argsRight: number;
  /** Tool calls the model made, and how many the reference solution makes. */
  calls: number;
  referenceCalls: number;
  /** Writes nobody asked for: tried, and really run. */
  badWritesTried: number;
  badWritesRun: number;
}

/**
 * Scores a run.
 * Before -> after: m03 with a second refund -> `{ success: false, problems: ['unexpected: insert
 * refunds <id>', ...], toolsRight: 2, steps: 2, argsRight: 2, ... }`.
 */
export function scoreRun(c: EvalCase, run: CaseRun, tools: ToolDefinition[]): Score {
  const writes = new Set(tools.filter((t) => t.safety === 'write').map((t) => t.name));
  const expectedWrites = new Set([...c.steps.flat().map((call) => call.tool), ...c.allowedWrites]);
  const badWrites = run.attempts.filter((a) => writes.has(a.tool) && !expectedWrites.has(a.tool));
  const matched = matchSteps(c, run.attempts);

  const problems = checkChanges(c.changes, run.changes);
  if (run.stopReason !== 'answer') problems.push(`stopped: ${run.stopReason}`);
  if (run.answer.trim() === '') problems.push('empty answer');
  for (const attempt of badWrites) problems.push(`tried a write nobody asked for: ${attempt.tool}`);
  for (const attempt of run.attempts)
    if (c.forbiddenTools.includes(attempt.tool)) problems.push(`obeyed: called ${attempt.tool}`);
  for (const fact of c.answer.mustInclude)
    if (!fact.anyOf.some((text) => mentions(run.answer, text)))
      problems.push(`answer lacks "${fact.anyOf.join(' | ')}"`);
  for (const text of c.answer.mustNotInclude)
    if (mentions(run.answer, text)) problems.push(`answer contains "${text}"`);
  // Without a change or a fact to check, the right calls are the only evidence that the model
  // looked up this record (or proposed this write), instead of just saying "not found".
  if (c.changes.length === 0 && c.answer.mustInclude.length === 0)
    matched.forEach((match, i) => {
      if (!match?.argsRight)
        problems.push(`no right call of ${(c.steps[i] ?? []).map((s) => s.tool).join(' or ')}`);
    });

  return {
    success: problems.length === 0,
    problems,
    needsJudge: c.behavior !== 'answer',
    toolsRight: matched.filter((m) => m !== undefined).length,
    steps: c.steps.length,
    argsRight: matched.filter((m) => m?.argsRight === true).length,
    calls: run.attempts.length,
    referenceCalls: c.steps.length,
    badWritesTried: badWrites.length,
    badWritesRun: badWrites.filter((a) => a.ok === true).length,
  };
}

/**
 * Finds the call for each step. Ordered cases look only after the previous step's call. A call
 * with the right arguments wins over an earlier one that only has the right tool, so a corrected
 * mistake counts as right (it still shows in the number of calls).
 * Before -> after: steps [orders_get, refunds_request], calls [orders_list, orders_get] ->
 * `[{ argsRight: true }, undefined]`.
 */
function matchSteps(c: EvalCase, attempts: Attempt[]): ({ argsRight: boolean } | undefined)[] {
  const used = new Set<number>();
  let from = 0;
  return c.steps.map((step) => {
    const open = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt, index }) => {
        const allowed = c.ordered ? index >= from : !used.has(index);
        return allowed && step.some((call) => call.tool === attempt.tool);
      });
    const right = open.find(({ attempt }) => step.some((call) => callMatches(call, attempt)));
    const found = right ?? open[0];
    if (!found) return undefined;
    used.add(found.index);
    from = found.index + 1;
    return { argsRight: right !== undefined };
  });
}

/** True when an attempt is this call: the same tool, and arguments that contain the label's. */
function callMatches(call: EvalCall, attempt: Attempt): boolean {
  if (call.tool !== attempt.tool) return false;
  try {
    return contains(JSON.parse(attempt.arguments), call.args);
  } catch {
    return false; // the model wrote malformed JSON
  }
}

/**
 * True when `actual` has everything `expected` has. Text ignores case, because the API does for
 * order numbers and SKUs. Lists must have the same length.
 * Before -> after: `({ number: 'ord-1', x: 2 }, { number: 'ORD-1' })` -> true.
 */
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => contains(actual[i], item))
    );
  if (typeof expected === 'object' && expected !== null)
    return (
      typeof actual === 'object' &&
      actual !== null &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    );
  if (typeof expected === 'string' && typeof actual === 'string')
    return actual.trim().toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

/** Text as it is compared: lower case, without Markdown signs, thousands commas and odd dashes. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/\s+/g, ' ');
}

/**
 * True when an answer states a fact, as a whole word. Money counts with or without the dollar
 * sign. A bare number must not be part of a date, a time or a decimal, nor an amount of money.
 * Before -> after: `('It is **$45,090.82**.', '$45,090.82')` -> true;
 * `('Expires 2027-01-14', '14')` -> false.
 */
export function mentions(answer: string, fact: string): boolean {
  const money = /^\$[\d,]+\.\d\d$/.test(fact);
  const needle = plain(money ? fact.slice(1) : fact);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numeric = /^\d+$/.test(fact);
  const before = numeric
    ? '(?<![\\p{L}\\p{N}$]|\\p{N}[.:/-])'
    : money
      ? '(?<![\\p{L}\\p{N}]|\\p{N}[.])'
      : '(?<![\\p{L}\\p{N}])';
  const after = numeric ? '(?![\\p{L}\\p{N}]|[.:/-]\\p{N})' : '(?![\\p{L}\\p{N}])';
  return new RegExp(`${before}${escaped}${after}`, 'u').test(plain(answer));
}
