/**
 * The graph's NODES and ROUTERS.
 *
 * A NODE is one unit of work: `(state, config) => partial state update`. It reads the state,
 * does one job (call the model, run tools...), and returns only the fields it changed. LangGraph
 * merges the update using each field's reducer (see state.ts), then decides which node runs next.
 *
 * A ROUTER is the function behind a conditional edge. It reads the state and returns the NAME of
 * the next node. Routers only decide; they never change state. In the raw loop these decisions
 * are `if`/`return` statements buried in a `for` loop. Here each one is a small named function,
 * so the control flow can be read (and drawn) on its own.
 *
 * Every node and router gets `config`, which carries:
 * - `config.context`: our dependencies (llm, registry, executor...), see AgentContext.
 * - `config.writer`: pushes a CUSTOM stream event to whoever is reading `graph.stream(...)` with
 *   `streamMode: "custom"`. We use it for progress events (thinking text, tool start/end).
 */
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

import type { AgentEvent, EmitEvent } from '../run-types.js';
import { answerStopReason, emptyUsage, modelCallUsage } from '../run-types.js';
import { runToolCalls, selectToolMenu, streamModelTurn, toolResultMessages } from '../steps.js';
import type { AgentContextValue, AgentStateUpdate, AgentStateValue } from './state.js';

/** The config every node receives, typed with our context. */
type NodeConfig = LangGraphRunnableConfig<AgentContextValue>;

/** The node names, in one place, so routers and the graph builder cannot drift apart. */
export const NODE = {
  selectTools: 'selectTools',
  callModel: 'callModel',
  executeTools: 'executeTools',
  finalize: 'finalize',
} as const;

/**
 * Reads our dependencies from the run's context. LangGraph types `context` as optional because a
 * graph can be run without one; ours never can, so a missing context is a programming error.
 */
function contextOf(config: NodeConfig): AgentContextValue {
  if (!config.context) throw new Error('Agent graph run started without a context');
  return config.context;
}

/**
 * Turns LangGraph's stream writer into our `EmitEvent` function, so the shared steps (which know
 * nothing about LangGraph) can report progress. Each event becomes one "custom" stream chunk.
 * `writer` is missing when the graph runs without streaming (`invoke`); events are then dropped.
 */
function emitterOf(config: NodeConfig): EmitEvent {
  return (event: AgentEvent) => {
    config.writer?.(event);
  };
}

/**
 * Node 1: picks the tool menu for this run, from the latest user message.
 * Before -> after: `{ messages: [user "refund ORD-7"], tools: [] }` -> update `{ tools: [6 tools] }`.
 */
export async function selectTools(
  state: AgentStateValue,
  config: NodeConfig,
): Promise<AgentStateUpdate> {
  const { registry, selector } = contextOf(config);
  const tools = await selectToolMenu(registry, selector, state.messages, emitterOf(config));
  return { tools };
}

/**
 * Node 2: one model call. Sends the conversation and menu, streams thinking and text as custom
 * events, and returns the reply. A reply with no tool calls is the answer, so it also sets
 * `stopReason` (`answer`, or `length` if the model ran out of tokens).
 * Before -> after: `{ iteration: 1, messages: [..3] }` ->
 * update `{ messages: [assistant reply], usage: { llmCalls: 1, ... }, iteration: 2 }`.
 */
export async function callModel(
  state: AgentStateValue,
  config: NodeConfig,
): Promise<AgentStateUpdate> {
  const { llm } = contextOf(config);
  const emit = emitterOf(config);
  const iteration = state.iteration + 1;

  const started = performance.now();
  const result = await streamModelTurn(llm, { messages: state.messages, tools: state.tools }, emit);
  emit({ type: 'llm-response', iteration, result, durationMs: performance.now() - started });

  const update: AgentStateUpdate = {
    messages: [result.message],
    usage: modelCallUsage(result.usage),
    iteration,
  };
  // A text answer can come at any step: local models cannot be forced to use tools.
  if (result.message.toolCalls.length === 0) update.stopReason = answerStopReason(result);
  return update;
}

/**
 * Node 3: runs the tool calls from the latest model reply and appends one `tool` message per
 * call. Then it checks the two limits; hitting one sets `stopReason`:
 * - too many failed results in a row -> `too_many_errors` (checked first, like the raw loop),
 * - the model-call budget is used up -> `max_iterations`.
 * Before -> after: last message asks for [orders_get] -> update
 * `{ messages: [tool result], usage: { toolCalls: 1, ... }, consecutiveErrors: 0 }`.
 */
export async function executeTools(
  state: AgentStateValue,
  config: NodeConfig,
): Promise<AgentStateUpdate> {
  const { registry, executor, limits } = contextOf(config);
  const last = state.messages.at(-1);
  const calls = last?.role === 'assistant' ? last.toolCalls : [];
  const offered = new Set(state.tools.map((tool) => tool.name));

  const results = await runToolCalls(calls, offered, registry, executor, emitterOf(config));
  const turn = toolResultMessages(calls, results, state.consecutiveErrors);

  const update: AgentStateUpdate = {
    messages: turn.messages,
    usage: { ...emptyUsage(), toolCalls: calls.length },
    consecutiveErrors: turn.consecutiveErrors,
  };
  if (turn.consecutiveErrors >= limits.maxConsecutiveToolErrors) {
    update.stopReason = 'too_many_errors';
  } else if (state.iteration >= limits.maxIterations) {
    update.stopReason = 'max_iterations';
  }
  return update;
}

/**
 * Node 4: the single exit of the graph. Every path ends here, which gives later steps one place
 * to hook in (budgets in 4.6, the audit record in 4.10). Today it writes the answer: the text of
 * the last reply when the model answered, and an empty string when a limit cut the run short.
 */
export function finalize(state: AgentStateValue): AgentStateUpdate {
  const answered = state.stopReason === 'answer' || state.stopReason === 'length';
  const last = state.messages.at(-1);
  return { answer: answered && last?.role === 'assistant' ? last.content : '' };
}

/**
 * Router after `callModel`: finish if the model answered, otherwise run its tool calls.
 * Returns a node name; LangGraph runs that node next.
 */
export function routeAfterModel(state: AgentStateValue): 'executeTools' | 'finalize' {
  return state.stopReason ? NODE.finalize : NODE.executeTools;
}

/** Router after `executeTools`: finish if a limit was hit, otherwise ask the model again. */
export function routeAfterTools(state: AgentStateValue): 'callModel' | 'finalize' {
  return state.stopReason ? NODE.finalize : NODE.callModel;
}
