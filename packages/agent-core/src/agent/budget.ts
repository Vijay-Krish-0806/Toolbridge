/**
 * Step 4.6: the run's TOKEN BUDGET, as pure functions the graph's model node calls.
 *
 * A budget is a safety limit first: it bounds what one run can cost (money on a paid model, GPU
 * time on a local one), the same way `maxIterations` bounds how long it can loop.
 *
 * The rule is "never START a model call that cannot fit". A call's prompt is the whole
 * conversation, so the next prompt is at least as big as the last one (the conversation only
 * grows). Before a call we therefore need room for that prompt plus a useful answer
 * (MIN_CALL_OUTPUT_TOKENS); if there is room, the call's output is limited to what is left. The
 * prompt's size is only known after the call, so a run can go over its cap by at most the
 * part of one prompt that the estimate missed. That overshoot is the price of not counting
 * tokens ourselves before every call.
 */
import type { AgentUsage } from './run-types.js';

/**
 * The smallest answer worth asking for. With less room than this the call is not made: a reply
 * cut off after a few tokens costs a whole prompt and says nothing.
 */
export const MIN_CALL_OUTPUT_TOKENS = 256;

/** Tokens a run has used so far: everything sent plus everything written. */
export function tokensUsed(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * How many output tokens the next model call may use, or `null` when it cannot fit and the run
 * must stop with `token_budget`. `undefined` cap = no budget = no limit (returns `undefined`).
 * Before -> after: cap 10,000, used 6,000, next prompt at least 3,000 -> 1,000;
 * cap 10,000, used 6,000, next prompt at least 3,900 -> null (100 left, below 256).
 */
export function nextCallAllowance(
  usage: AgentUsage,
  maxRunTokens: number | undefined,
  nextPromptAtLeast: number,
): number | null | undefined {
  if (maxRunTokens === undefined) return undefined;
  const left = maxRunTokens - tokensUsed(usage) - nextPromptAtLeast;
  return left >= MIN_CALL_OUTPUT_TOKENS ? left : null;
}
