/**
 * The oracle replay: runs a case's own reference calls on the real host, and checks that the
 * labels are true. If the reference cannot pass, no agent can, and the label is wrong.
 */
import type { ToolExecutor, ToolResult } from '@toolbridge/agent-core';
import { findInstructions } from '@toolbridge/policy';

import type { EvalCall, EvalCase, Expectation } from './dataset.js';
import type { EvalHost } from './host.js';
import type { StoreTools } from './store-tools.js';
import { checkChanges, diffWorlds, type World } from './world.js';

export interface ReplayResult {
  problems: string[];
  /** True when the database must be reset before the next case. */
  dirty: boolean;
}

/** Replays one case on a freshly seeded host. `seeded` is the database before it. */
export async function replayCase(
  c: EvalCase,
  host: EvalHost,
  store: StoreTools,
  seeded: World,
): Promise<ReplayResult> {
  const executor = host.executorFor(c.role);
  const problems: string[] = [];

  // Evidence first, on the untouched database. It must not change anything.
  for (const call of c.evidence) problems.push(...(await runCall(executor, call)).problems);
  const evidenceChanges = diffWorlds(seeded, await host.world());
  if (evidenceChanges.length) problems.push('the evidence calls changed the database');

  // An approver who rejects means the write never runs.
  const writes = new Set(store.tools.filter((t) => t.safety === 'write').map((t) => t.name));
  let seen = '';
  for (const [reference] of c.steps) {
    if (!reference || (c.approval === 'reject' && writes.has(reference.tool))) continue;
    const { problems: found, text } = await runCall(executor, reference);
    problems.push(...found);
    seen += `${text}\n`;
  }
  // Alternatives that only read must work as well. (A second write would change the world.)
  for (const call of c.steps.flatMap((step) => step.slice(1)))
    if (!writes.has(call.tool)) problems.push(...(await runCall(executor, call)).problems);

  const changes = diffWorlds(seeded, await host.world());
  problems.push(...checkChanges(c.changes, changes));

  for (const fact of c.answer.mustInclude)
    if (!fact.anyOf.some((text) => isGrounded(text, seen)))
      problems.push(`no tool result contains "${fact.anyOf.join(' | ')}"`);

  // Injection cases must really show the model poisoned text; the others must not.
  const poisoned = findInstructions(seen).length > 0;
  if (poisoned !== (c.category === 'injection'))
    problems.push(poisoned ? 'reads poisoned text' : 'never reads poisoned text');
  return { problems, dirty: changes.length > 0 };
}

/** Runs one call and compares the host's answer with the label. */
async function runCall(
  executor: ToolExecutor,
  call: EvalCall,
): Promise<{ problems: string[]; text: string }> {
  const result = await executor.run({
    id: 'replay',
    name: call.tool,
    arguments: JSON.stringify({ ...call.args, ...call.fill }),
  });
  const got = outcomeOf(result);
  const matches = got === call.expect || (call.expect === 'ok' && got === 'many');
  const detail = result.ok ? '' : `: ${result.error.message}`;
  return {
    problems: matches ? [] : [`${call.tool}: expected ${call.expect}, got ${got}${detail}`],
    text: result.ok ? result.content : result.error.message,
  };
}

const STATUS: Partial<Record<number, Expectation>> = {
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

/**
 * Names what the host answered. Before -> after: a page with `total: 0` -> `'empty'`; HTTP 409 ->
 * `'conflict'`; a page with 4 matches -> `'many'`; any other failure -> its error code.
 */
function outcomeOf(result: ToolResult): string {
  if (!result.ok) return STATUS[result.error.status ?? 0] ?? result.error.code;
  const body: unknown = JSON.parse(result.content);
  if (typeof body === 'object' && body !== null && 'total' in body && 'items' in body) {
    if (body.total === 0) return 'empty';
    if (typeof body.total === 'number' && body.total > 1) return 'many';
  }
  return 'ok';
}

/**
 * True when a fact can be read from the tool results, which are JSON:
 * - money: the amount in cents as a JSON number, and a bare number likewise. Not just anywhere in
 *   the text: "12" must not be found in the month of "2026-12-16";
 * - other text: as whole words; an ISO date may be followed by its time.
 * Before -> after: `('$589.92', '{"totalCents":58992}')` -> true.
 */
function isGrounded(fact: string, results: string): boolean {
  const money = /^\$([\d,]+)\.(\d\d)$/.exec(fact);
  const number = money
    ? `${(money[1] ?? '').replaceAll(',', '')}${money[2] ?? ''}`.replace(/^0+(?=\d)/, '')
    : /^\d+$/.exec(fact)?.[0];
  if (number !== undefined) return new RegExp(`:${number}(?![\\d.])`).test(results);
  const escaped = fact.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = /^\d{4}-\d\d-\d\d$/.test(fact) ? '(?!\\p{N})' : '(?![\\p{L}\\p{N}])';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${end}`, 'u').test(results.toLowerCase());
}
