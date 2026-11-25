/**
 * EXPOSURE (Step 4.9, ADR 0047): what the model has read so far in a run, as far as trust goes. This
 * is TAINT TRACKING: instead of asking whether a text is an attack (nobody can tell reliably), we
 * remember that text from outside was read at all, and treat everything the model writes after that
 * as possibly influenced by it. The approval policy turns it into stricter rules for writes.
 *
 * - `none`: only our own rules and the user's words.
 * - `seen`: text from a tool (an order, a customer note, an API error message).
 * - `flagged`: text from a tool that looked like instructions.
 * It only goes up: trimming a result out of the prompt, or a summary, does not undo having read it.
 */
import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/executor.js';
import type { Tool } from '../tools/tool.js';

export const EXPOSURES = ['none', 'seen', 'flagged'] as const;
export type Exposure = (typeof EXPOSURES)[number];

/** A call whose result looked like instructions: which one, and the kinds found. Never the text. */
export interface FlaggedCall {
  tool: string;
  arguments: string;
  flags: string[];
}

/** Most flagged calls kept for the approval card. */
export const MAX_FLAGGED = 5;

/** The stricter of two. Before -> after: ('flagged', 'seen') -> 'flagged'. */
export function worseExposure(a: Exposure, b: Exposure): Exposure {
  return EXPOSURES.indexOf(a) >= EXPOSURES.indexOf(b) ? a : b;
}

/**
 * Whether a result holds text from outside: any success, and errors that quote the API or the tool.
 * The other errors are our own words (a refused, limited or cancelled call). A local tool answers
 * with our own words too.
 */
export function isUntrusted(result: ToolResult, tool: Pick<Tool, 'local'> | undefined): boolean {
  if (!tool || tool.local === true) return false;
  return result.ok || result.error.code === 'http_error' || result.error.code === 'internal';
}

/** What one turn's results add: the new exposure, and the calls that were flagged. */
export function exposureOfTurn(
  calls: ToolCall[],
  results: ToolResult[],
  toolOf: (name: string) => Pick<Tool, 'local'> | undefined,
): { exposure: Exposure; flagged: FlaggedCall[] } {
  let exposure: Exposure = 'none';
  const flagged: FlaggedCall[] = [];
  calls.forEach((call, i) => {
    const result = results[i];
    if (!result || !isUntrusted(result, toolOf(call.name))) return;
    const flags = result.flags ?? [];
    exposure = worseExposure(exposure, flags.length > 0 ? 'flagged' : 'seen');
    if (flags.length > 0) flagged.push({ tool: call.name, arguments: call.arguments, flags });
  });
  return { exposure, flagged };
}
