/**
 * The framework-free agent engine (the ReAct pattern): ask the model, run the tools it asks for,
 * append the results, and repeat until it answers in plain text or a limit stops it.
 * Kept as the baseline for the LangGraph engine in `graph/` (ADR 0025).
 */
import {
  type AgentRunInput,
  type AgentRunResult,
  DEFAULT_LIMITS,
  type StopReason,
  addUsage,
  answerStopReason,
  emptyUsage,
  modelCallUsage,
} from './run-types.js';
import { runToolCalls, selectToolMenu, streamModelTurn, toolResultMessages } from './steps.js';

/**
 * Runs the loop once for the latest user message. Each iteration:
 * 1. send the conversation and tool menu to the model,
 * 2. if it answered with text only, stop,
 * 3. otherwise run its tool calls and append each result as a `tool` message, then repeat.
 * Tool errors are appended like any result, so the model can recover; only a run of
 * consecutive errors or the iteration limit stops the loop early.
 */
export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const emit = input.onEvent ?? (() => undefined);
  const messages = [...input.messages];
  const tools = await selectToolMenu(
    input.registry,
    input.selector,
    messages,
    emit,
    input.access,
  );
  const offered = new Set(tools.map((tool) => tool.name));
  let usage = emptyUsage();
  let consecutiveErrors = 0;

  /** Packs up the run's outcome. */
  const finish = (stopReason: StopReason, answer = ''): AgentRunResult => ({
    messages,
    answer,
    stopReason,
    usage,
  });

  for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
    const started = performance.now();
    const result = await streamModelTurn(input.llm, { messages, tools }, emit);
    emit({ type: 'llm-response', iteration, result, durationMs: performance.now() - started });
    usage = addUsage(usage, modelCallUsage(result.usage));
    messages.push(result.message);

    const calls = result.message.toolCalls;
    if (calls.length === 0) {
      // A text answer can come at any step: local models cannot be forced to use tools.
      return finish(answerStopReason(result), result.message.content);
    }

    const results = await runToolCalls(
      calls,
      offered,
      input.registry,
      input.executor,
      emit,
      input.access?.principal,
    );
    usage = addUsage(usage, { ...emptyUsage(), toolCalls: calls.length });
    const turn = toolResultMessages(calls, results, consecutiveErrors);
    messages.push(...turn.messages);
    consecutiveErrors = turn.consecutiveErrors;
    if (consecutiveErrors >= limits.maxConsecutiveToolErrors) {
      return finish('too_many_errors');
    }
  }
  return finish('max_iterations');
}
