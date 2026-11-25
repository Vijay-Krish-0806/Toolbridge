/**
 * Checks of the labels that need no host: does every label agree with the compiled tools, the role
 * policy and the rules of its category? Pure: the same inputs always give the same problems.
 */
import { decide } from '@toolbridge/policy';
import type { ToolDefinition } from '@toolbridge/spec-compiler';
import { z } from 'zod';

import { CATEGORIES, type Category, type EvalCall, type EvalCase } from './dataset.js';
import type { StoreTools } from './store-tools.js';

/** The behavior each category must have; undefined means any. */
const BEHAVIOR: Partial<Record<Category, EvalCase['behavior']>> = {
  ambiguous: 'clarify',
  forbidden: 'refuse',
  'no-data': 'not_found',
};

/**
 * Problems of the set as a whole: wrong counts, repeated ids or questions.
 * Before -> after: 8 single cases instead of 9 -> `['single: 8 cases, expected 9']`.
 */
export function checkSet(cases: EvalCase[]): string[] {
  const problems: string[] = [];
  for (const [category, want] of Object.entries(CATEGORIES)) {
    const mine = cases.filter((c) => c.category === category);
    const test = mine.filter((c) => c.split === 'test').length;
    if (mine.length !== want.total)
      problems.push(`${category}: ${String(mine.length)} cases, expected ${String(want.total)}`);
    if (test !== want.test)
      problems.push(`${category}: ${String(test)} test cases, expected ${String(want.test)}`);
  }
  for (const key of ['id', 'question'] as const) {
    const seen = new Set<string>();
    for (const c of cases) {
      const value = c[key].toLowerCase();
      if (seen.has(value)) problems.push(`${c.id}: this ${key} is used twice`);
      seen.add(value);
    }
  }
  return problems;
}

/**
 * Problems of one case. Before -> after: a support case whose step calls `reports_sales` ->
 * `['reports_sales: the policy denies support']`.
 */
export function checkCase(c: EvalCase, store: StoreTools): string[] {
  const problems: string[] = [];
  const byName = new Map(store.tools.map((t) => [t.name, t]));
  const allowed = (tool: string) => decide(store.policy, c.role, tool).allowed;
  const isWrite = (tool: string) => byName.get(tool)?.safety === 'write';

  for (const call of c.steps.flat()) {
    problems.push(...checkCall(call, byName));
    if (!allowed(call.tool)) problems.push(`${call.tool}: the policy denies ${c.role}`);
  }
  for (const call of c.evidence) {
    problems.push(...checkCall(call, byName));
    if (allowed(call.tool) === (call.expect === 'forbidden'))
      problems.push(
        `${call.tool}: evidence "${call.expect}" does not match the policy for ${c.role}`,
      );
    if (call.expect === 'ok' && isWrite(call.tool))
      problems.push(`${call.tool}: evidence must not be a write that succeeds`);
  }
  for (const tool of [...c.allowedWrites, ...c.forbiddenTools])
    if (!byName.has(tool)) problems.push(`${tool}: no such tool`);
  for (const tool of c.allowedWrites)
    if (!isWrite(tool)) problems.push(`${tool}: in allowedWrites, but not a write`);
  for (const tool of c.forbiddenTools)
    if (c.steps.flat().some((call) => call.tool === tool))
      problems.push(`${tool}: both a step and forbidden`);

  const writes = c.steps.filter((step) => step.some((call) => isWrite(call.tool))).length;
  if (c.approval === 'approve' && writes > 0 !== c.changes.length > 0)
    problems.push('write steps and expected changes must come together');
  if (c.approval === 'reject' && (writes === 0 || c.changes.length > 0))
    problems.push('a rejected case needs a write step and no changes');
  if (c.approval === 'reject' && c.behavior !== 'refuse')
    problems.push('a rejected write must be reported as not done (behavior "refuse")');
  if (['clarify', 'not_found'].includes(c.behavior) && writes > 0)
    problems.push(`behavior "${c.behavior}" cannot contain a write step`);
  for (const change of c.changes) {
    const fields = Object.keys(change.set).length + change.touches.length;
    if (change.op === 'insert' && fields > 0)
      problems.push('an insert is described by `where` only');
    if (change.op === 'update' && Object.keys(change.set).length === 0)
      problems.push('an update needs `set`');
  }

  const behavior = BEHAVIOR[c.category];
  if (behavior && c.behavior !== behavior)
    problems.push(`${c.category} needs behavior "${behavior}"`);
  const expects = [...c.steps.flat(), ...c.evidence].map((call) => call.expect);
  if (c.category === 'forbidden' && !expects.some((e) => e === 'forbidden' || e === 'conflict'))
    problems.push('forbidden needs evidence of the refusal');
  if (c.category === 'no-data' && !expects.some((e) => e === 'empty' || e === 'not_found'))
    problems.push('no-data needs a call that finds nothing');
  if (c.category === 'single' && c.steps.length !== 1) problems.push('single needs one step');
  if (c.category === 'multi-step' && c.steps.length < 2)
    problems.push('multi-step needs two or more steps');
  if (c.behavior === 'answer' && c.changes.length === 0 && c.answer.mustInclude.length === 0)
    problems.push('a read-only answer needs at least one fact to check');

  // A fact that is already in the question proves nothing: the model could just repeat it.
  for (const fact of c.answer.mustInclude)
    if (fact.anyOf.some((text) => c.question.toLowerCase().includes(text.toLowerCase())))
      problems.push(`answer fact "${fact.anyOf.join(' | ')}" is already in the question`);
  return problems;
}

/** The tool exists, every argument is one of its arguments, and the values fit its schema. */
function checkCall(call: EvalCall, byName: Map<string, ToolDefinition>): string[] {
  const tool = byName.get(call.tool);
  if (!tool) return [`${call.tool}: no such tool`];
  const given = { ...call.args, ...call.fill };
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(given).filter((name) => !(name in properties));
  const schema = z.fromJSONSchema(tool.inputSchema);
  const result = schema.safeParse(given);
  return [
    ...unknown.map((name) => `${call.tool}: no argument "${name}"`),
    ...(result.success ? [] : [`${call.tool}: ${z.prettifyError(result.error)}`]),
  ];
}
