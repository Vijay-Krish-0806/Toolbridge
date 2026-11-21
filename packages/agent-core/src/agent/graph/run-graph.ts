/**
 * Runs the LangGraph engine behind the same contract as the raw loop: `runAgentGraph(input)` takes
 * an `AgentRunInput` and returns an `AgentRunResult`, so callers can switch engines with one flag.
 */
import type { AgentEvent, AgentRunInput, AgentRunResult } from '../run-types.js';
import { DEFAULT_LIMITS } from '../run-types.js';
import { type AgentGraph, buildAgentGraph } from './build-graph.js';
import type { AgentStateValue } from './state.js';

/** Compiled on the first run and reused: the graph itself holds no per-run data. */
let sharedGraph: AgentGraph | undefined;

/**
 * Runs the graph once for the latest user message.
 *
 * It uses `graph.stream` (not `invoke`) with two STREAM MODES at once:
 * - `"custom"`: the progress events our nodes push with `config.writer(...)`. We pass each one to
 *   `input.onEvent`, so the CLI shows thinking text and tool calls live, as with the raw loop.
 * - `"values"`: the full state after every super-step. We keep the last one: the final state.
 * With an array of modes, every chunk arrives as a `[mode, data]` pair.
 *
 * `recursionLimit` is LangGraph's own cap on super-steps (default 25); hitting it throws
 * `GraphRecursionError`. Our `maxIterations` check stops the run first and gives a clean
 * `stopReason`, so the cap is only a backstop: 2 steps per iteration (callModel + executeTools)
 * plus selectTools and finalize, plus some room.
 */
export async function runAgentGraph(input: AgentRunInput): Promise<AgentRunResult> {
  sharedGraph ??= buildAgentGraph();
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const emit = input.onEvent ?? (() => undefined);

  const stream = await sharedGraph.stream(
    // The input is a state update like any other: `messages` goes through the append reducer.
    // A copy is passed so the caller's array is never modified.
    { messages: [...input.messages] },
    {
      context: {
        llm: input.llm,
        registry: input.registry,
        executor: input.executor,
        selector: input.selector,
        limits,
        access: input.access,
      },
      streamMode: ['custom', 'values'],
      recursionLimit: limits.maxIterations * 2 + 4,
    },
  );

  let final: AgentStateValue | undefined;
  for await (const [mode, chunk] of stream) {
    if (mode === 'custom') emit(chunk as AgentEvent);
    else final = chunk;
  }
  if (!final?.stopReason) throw new Error('Agent graph ended without a stop reason');

  return {
    messages: final.messages,
    answer: final.answer,
    stopReason: final.stopReason,
    usage: final.usage,
  };
}
