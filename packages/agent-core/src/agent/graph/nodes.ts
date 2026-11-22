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
import { type LangGraphRunnableConfig, interrupt } from '@langchain/langgraph';

import {
  type ApprovalDecision,
  type ApprovalRequest,
  type CallToCheck,
  approvalDecisionSchema,
} from '../approval.js';
import type { ChatMessage, ToolCall } from '../../llm/types.js';
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
  approvalGate: 'approvalGate',
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
  const { registry, selector, access } = contextOf(config);
  const tools = await selectToolMenu(registry, selector, state.messages, emitterOf(config), access);
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
  // `config.signal` is LangGraph's abort signal for the whole run (a time limit or a cancel,
  // Step 4.4a); passing it on makes the model request stop at once instead of streaming on.
  const result = await streamModelTurn(
    llm,
    {
      messages: state.messages,
      tools: state.tools,
      ...(config.signal && { signal: config.signal }),
    },
    emit,
  );
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
 * Node 3 (Step 4.3): the approval gate, between the model's reply and running its tools.
 *
 * WHY THIS IS ITS OWN NODE, AND WHY IT HAS NO SIDE EFFECTS: `interrupt()` pauses the run and
 * saves it in the checkpointer. When a person answers, LangGraph RESUMES BY RE-RUNNING THIS NODE
 * FROM ITS FIRST LINE (LangGraph.js interrupts docs); this time `interrupt()` returns the answer
 * instead of pausing. So everything before `interrupt()` runs twice. This node only reads state
 * and computes; it writes nothing anywhere. The writes happen in `executeTools`, which runs only
 * after this node has finished with an approval. (Saving the approval record is the run
 * service's job, outside the graph, when it sees the pause.)
 *
 * All or nothing: one card for the whole turn. Approved -> every call runs. Rejected -> none
 * runs, and each call gets a "not run" tool message so the model can tell the user.
 * Defense in depth: for a `high` batch the approver must differ from the requester. The API
 * checks it first (session b); this node checks again, and a violation counts as a rejection.
 */
export function approvalGate(state: AgentStateValue, config: NodeConfig): AgentStateUpdate {
  const { approvals, registry, access, limits } = contextOf(config);
  const calls = lastToolCalls(state);
  if (!approvals) return { approvalOutcome: 'not_needed' };

  // Only calls to tools on this run's menu can run; the others are refused in executeTools
  // ("not available"), so they need no approval. Without this, a spec with no policy (empty
  // menu) would put a card in the inbox for every call the model invents, for nothing.
  const offered = new Set(state.tools.map((tool) => tool.name));
  const runnable = calls.filter((call) => offered.has(call.name));
  const checks: CallToCheck[] = runnable.map((call) => ({
    name: call.name,
    // An offered tool missing from the registry cannot happen; treat it as a write to be safe.
    safety: registry.get(call.name)?.safety ?? 'write',
    args: parseArgs(call.arguments),
  }));
  const batch = approvals.evaluate(checks);
  if (batch.level === 'none') return { approvalOutcome: 'not_needed' };
  // Each call's own level, in the order of `calls`; not-offered calls get `none` with a reason.
  const decided = new Map(runnable.map((call, i) => [call.id, batch.calls[i]]));

  const request: ApprovalRequest = {
    level: batch.level,
    requesterId: access?.principal.userId ?? '',
    calls: calls.map((call) => {
      const own = decided.get(call.id);
      return {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        level: own?.level ?? 'none',
        reason: own?.reason ?? 'Not offered to this run, so it will be refused, not run.',
      };
    }),
  };
  // First pass: pauses the run here. On resume: returns the person's answer.
  const answer: unknown = interrupt(request);
  const refusal = refusalOf(request, answer);
  if (!refusal) return { approvalOutcome: 'approved' };

  const update: AgentStateUpdate = {
    approvalOutcome: 'rejected',
    messages: calls.map((call): ChatMessage => ({
      role: 'tool',
      toolCallId: call.id,
      content: refusal,
    })),
  };
  if (state.iteration >= limits.maxIterations) update.stopReason = 'max_iterations';
  return update;
}

/**
 * Node 4: runs the tool calls from the latest model reply and appends one `tool` message per
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
  const { registry, executor, limits, access } = contextOf(config);
  const calls = lastToolCalls(state);
  const offered = new Set(state.tools.map((tool) => tool.name));

  const results = await runToolCalls(
    calls,
    offered,
    registry,
    executor,
    emitterOf(config),
    access?.principal,
    config.signal,
  );
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
 * Node 5: the single exit of the graph. Every path ends here, which gives later steps one place
 * to hook in (budgets in 4.6, the audit record in 4.10). Today it writes the answer: the text of
 * the last reply when the model answered, and an empty string when a limit cut the run short.
 */
export function finalize(state: AgentStateValue): AgentStateUpdate {
  const answered = state.stopReason === 'answer' || state.stopReason === 'length';
  const last = state.messages.at(-1);
  return { answer: answered && last?.role === 'assistant' ? last.content : '' };
}

/**
 * Router after `callModel`: finish if the model answered, otherwise check its tool calls for
 * approval. Returns a node name; LangGraph runs that node next.
 */
export function routeAfterModel(state: AgentStateValue): 'approvalGate' | 'finalize' {
  return state.stopReason ? NODE.finalize : NODE.approvalGate;
}

/**
 * Router after `approvalGate`: approved (or nothing to approve) -> run the tools; rejected -> back
 * to the model with the "not run" messages; a limit hit while rejected -> finish.
 */
export function routeAfterApproval(
  state: AgentStateValue,
): 'executeTools' | 'callModel' | 'finalize' {
  if (state.stopReason) return NODE.finalize;
  return state.approvalOutcome === 'rejected' ? NODE.callModel : NODE.executeTools;
}

/** Router after `executeTools`: finish if a limit was hit, otherwise ask the model again. */
export function routeAfterTools(state: AgentStateValue): 'callModel' | 'finalize' {
  return state.stopReason ? NODE.finalize : NODE.callModel;
}

/** The tool calls of the latest model reply (empty if the last message is not an assistant reply). */
function lastToolCalls(state: AgentStateValue): ToolCall[] {
  const last = state.messages.at(-1);
  return last?.role === 'assistant' ? last.toolCalls : [];
}

/**
 * Parses a call's raw arguments for the approval rules. Bad JSON gives `{}`: threshold rules then
 * do not match and the call falls back to the stricter default, and the executor rejects the
 * call later anyway.
 * Before -> after: `'{"amountCents":500}'` -> `{ amountCents: 500 }`; `'oops'` -> `{}`.
 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Checks the person's answer. Returns undefined when the batch may run, or the "not run" text to
 * give the model. Fails closed: a malformed answer, a rejection, a self-approval of a `high`
 * batch, or a `high` batch without a known requester are all refusals.
 * Before -> after: `{ decision: 'approved', approverId: 'u2' }` (requester u1, high) -> undefined;
 * `{ decision: 'approved', approverId: 'u1' }` (requester u1, high) ->
 * `'Not run: a high-risk action cannot be approved by the person who requested it.'`.
 */
function refusalOf(request: ApprovalRequest, answer: unknown): string | undefined {
  const parsed = approvalDecisionSchema.safeParse(answer);
  if (!parsed.success) return 'Not run: the approval answer was not valid.';
  const decision: ApprovalDecision = parsed.data;
  if (decision.decision === 'rejected') {
    return `Not run: rejected by ${decision.approverId}${decision.reason ? `: ${decision.reason}` : '.'}`;
  }
  if (request.level === 'high') {
    if (!request.requesterId) return 'Not run: a high-risk action needs a known requester.';
    if (decision.approverId === request.requesterId) {
      return 'Not run: a high-risk action cannot be approved by the person who requested it.';
    }
  }
  return undefined;
}
