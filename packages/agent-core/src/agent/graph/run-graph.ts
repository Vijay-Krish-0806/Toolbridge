/**
 * Runs the LangGraph engine.
 * - `runAgentGraph(input)`: the same contract as the raw loop (input in, finished result out), for
 *   callers that switch engines with one flag. It cannot pause, so it takes no approval rules.
 * - `startAgentRun` / `resumeAgentRun` (Step 4.3): DURABLE runs. They need a checkpointer and a
 *   run id, and can stop half-way to wait for a person's approval, then continue later, even in
 *   another process after a restart.
 */
import { type BaseCheckpointSaver, Command, type START } from '@langchain/langgraph';

import type { ApprovalDecision, ApprovalRequest } from '../approval.js';
import type { AgentEvent, AgentRunInput, AgentRunResult, EmitEvent } from '../run-types.js';
import { DEFAULT_LIMITS } from '../run-types.js';
import { type AgentGraph, buildAgentGraph } from './build-graph.js';
import type { NODE } from './nodes.js';
import type { AgentStateUpdate, AgentStateValue } from './state.js';

/** Node names as LangGraph types them, so a Command is checked against our graph. */
type NodeName = (typeof NODE)[keyof typeof NODE] | typeof START;
/** What `graph.stream` accepts as input: a state update, or a Command such as a resume. */
type StreamInput = Parameters<AgentGraph['stream']>[0];

/** How a durable run stands after a call: finished, or paused on an approval card. */
export type AgentRunOutcome =
  | { status: 'finished'; result: AgentRunResult }
  | { status: 'waiting_for_approval'; request: ApprovalRequest };

/** A durable run: `runId` becomes LangGraph's `thread_id`, the key of its saved checkpoints. */
export interface DurableRunInput extends AgentRunInput {
  runId: string;
  checkpointer: BaseCheckpointSaver;
  /**
   * Stops the run (Step 4.4a: a leg's time limit, or a cancel). LangGraph passes it to every
   * node as `config.signal`, and our nodes hand it to the model request and the tool calls.
   * The run then throws; work saved in earlier checkpoints is kept.
   */
  signal?: AbortSignal;
}

/**
 * Where a durable run stands, read from its checkpoints: `new` (no checkpoint yet: start it),
 * `unfinished` (stopped half-way because a process died or a leg failed: continue it), or the
 * same outcome a leg returns (paused on a card, with the card; or finished, with the result).
 */
export type DurableRunState = { status: 'new' } | { status: 'unfinished' } | AgentRunOutcome;

/**
 * Continuing a paused run. The conversation is NOT passed again: it is in the checkpoint. The
 * dependencies (model, tools, identity, rules) ARE passed again, because context is never saved.
 */
export interface ResumeRunInput extends Omit<DurableRunInput, 'messages'> {
  decision: ApprovalDecision;
}

/** Compiled on the first run and reused: the graph itself holds no per-run data. */
let plainGraph: AgentGraph | undefined;
/** One compiled graph per checkpointer. */
const durableGraphs = new WeakMap<BaseCheckpointSaver, AgentGraph>();

/**
 * Runs the graph once for the latest user message, without a checkpointer.
 *
 * It uses `graph.stream` (not `invoke`) with two STREAM MODES at once:
 * - `"custom"`: the progress events our nodes push with `config.writer(...)`. We pass each one to
 *   `input.onEvent`, so the CLI shows thinking text and tool calls live, as with the raw loop.
 * - `"values"`: the full state after every super-step. We keep the last one: the final state.
 * With an array of modes, every chunk arrives as a `[mode, data]` pair.
 */
export async function runAgentGraph(input: AgentRunInput): Promise<AgentRunResult> {
  if (input.approvals) {
    throw new Error('Approval rules need a durable run: use startAgentRun with a checkpointer.');
  }
  plainGraph ??= buildAgentGraph();
  const emit = input.onEvent ?? (() => undefined);
  const final = await drive(plainGraph, { messages: [...input.messages] }, runConfig(input), emit);
  return finishedResult(final);
}

/**
 * Starts a durable run. Returns `finished`, or `waiting_for_approval` with the approval card when
 * the model asked for a write that needs a person. Every step is saved under `runId`.
 * Before -> after: "refund ORD-7 in full" (high-risk) ->
 * `{ status: 'waiting_for_approval', request: { level: 'high', calls: [{ name: 'refunds_request', ... }] } }`.
 */
export async function startAgentRun(input: DurableRunInput): Promise<AgentRunOutcome> {
  const graph = durableGraph(input.checkpointer);
  const config = { ...runConfig(input), configurable: { thread_id: input.runId } };
  // The input is a state update like any other: `messages` goes through the append reducer.
  // A copy is passed so the caller's array is never modified.
  await drive(graph, { messages: [...input.messages] }, config, input.onEvent);
  return outcomeOf(graph, input.runId);
}

/**
 * Continues a run that is waiting for approval, with the person's decision. LangGraph re-runs
 * `approvalGate` from its start; this time `interrupt()` returns `decision`. Refuses a run that
 * is not waiting (finished, or never paused): resuming twice must never run a write twice.
 */
export async function resumeAgentRun(input: ResumeRunInput): Promise<AgentRunOutcome> {
  const graph = durableGraph(input.checkpointer);
  const before = await outcomeOf(graph, input.runId);
  if (before.status !== 'waiting_for_approval') {
    throw new Error(`Run ${input.runId} is not waiting for approval.`);
  }
  const config = { ...runConfig(input), configurable: { thread_id: input.runId } };
  // `Command({ resume })` is the one Command LangGraph accepts as input: "continue the paused
  // node, and make interrupt() return this value".
  const resume = new Command<ApprovalDecision, AgentStateUpdate, NodeName>({
    resume: input.decision,
  });
  await drive(graph, resume, config, input.onEvent);
  return outcomeOf(graph, input.runId);
}

/**
 * Continues a run that stopped half-way, from its last checkpoint (Step 4.4a: a worker died, or
 * a leg failed and is retried). Input `null` tells LangGraph "no new input: finish the work
 * that is due". Nodes that completed in the interrupted super-step are not run again (their
 * writes were saved), but the node that was running starts over: that is why a write that had
 * already started is refused by the audit guard instead of being repeated.
 */
export async function continueAgentRun(
  input: Omit<DurableRunInput, 'messages'>,
): Promise<AgentRunOutcome> {
  const graph = durableGraph(input.checkpointer);
  const config = { ...runConfig(input), configurable: { thread_id: input.runId } };
  await drive(graph, null, config, input.onEvent);
  return outcomeOf(graph, input.runId);
}

/**
 * Reads a run's state from its checkpoints, so a worker knows which of start, continue or
 * resume to call. `next` lists the nodes due to run; empty means the graph reached its end.
 * Before -> after: a thread paused on a card -> `{ status: 'waiting_for_approval', request }`;
 * an unknown id -> `{ status: 'new' }`.
 */
export async function durableRunState(
  checkpointer: BaseCheckpointSaver,
  runId: string,
): Promise<DurableRunState> {
  const graph = durableGraph(checkpointer);
  const snapshot = await graph.getState({ configurable: { thread_id: runId } });
  if (snapshot.createdAt === undefined) return { status: 'new' };
  const paused = snapshot.tasks.some((task) => task.interrupts.length > 0);
  if (!paused && snapshot.next.length > 0) return { status: 'unfinished' };
  return outcomeOf(graph, runId);
}

/** The compiled graph for one checkpointer, built on first use. */
function durableGraph(checkpointer: BaseCheckpointSaver): AgentGraph {
  let graph = durableGraphs.get(checkpointer);
  if (!graph) {
    graph = buildAgentGraph(checkpointer);
    durableGraphs.set(checkpointer, graph);
  }
  return graph;
}

/**
 * The per-run config: the context (dependencies, never saved in a checkpoint), the stream modes,
 * and LangGraph's own step cap.
 * `recursionLimit` is LangGraph's cap on super-steps (default 25); hitting it throws
 * `GraphRecursionError`. Our `maxIterations` check stops the run first with a clean `stopReason`,
 * so the cap is only a backstop: 3 steps per iteration (callModel, approvalGate, executeTools)
 * plus selectTools and finalize, plus some room.
 */
function runConfig(input: Omit<AgentRunInput, 'messages'> & { signal?: AbortSignal }) {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  // Every key is present (some may be undefined): LangGraph's context type requires that.
  const context = {
    llm: input.llm,
    registry: input.registry,
    executor: input.executor,
    selector: input.selector,
    limits,
    access: input.access,
    approvals: input.approvals,
  };
  return {
    context,
    streamMode: ['custom', 'values'] as ['custom', 'values'],
    recursionLimit: limits.maxIterations * 3 + 4,
    // DURABILITY "sync": each checkpoint is saved before the next step starts (the default,
    // "async", saves while the next step already runs, so a crash can lose the latest one).
    // Without a checkpointer there is nothing to save, so the option is harmless there.
    durability: 'sync' as const,
    ...(input.signal && { signal: input.signal }),
  };
}

/**
 * Streams one leg of a run (until it ends or pauses), passing custom events to `emit`, and
 * returns the last full state it saw.
 */
async function drive(
  graph: AgentGraph,
  input: StreamInput,
  config: ReturnType<typeof runConfig> & { configurable?: { thread_id: string } },
  emit: EmitEvent = () => undefined,
): Promise<AgentStateValue | undefined> {
  let last: AgentStateValue | undefined;
  for await (const [mode, chunk] of await graph.stream(input, config)) {
    if (mode === 'custom') emit(chunk as AgentEvent);
    else last = chunk;
  }
  return last;
}

/**
 * Reads where a durable run stands from its saved checkpoint. A paused run has a task with a
 * pending interrupt, whose value is our approval card. Otherwise the run has finished.
 */
async function outcomeOf(graph: AgentGraph, runId: string): Promise<AgentRunOutcome> {
  const snapshot = await graph.getState({ configurable: { thread_id: runId } });
  const pending = snapshot.tasks.flatMap((task) => task.interrupts)[0];
  if (pending) return { status: 'waiting_for_approval', request: pending.value as ApprovalRequest };
  return { status: 'finished', result: finishedResult(snapshot.values as AgentStateValue) };
}

/** The final state as the engine contract's result. A run must end with a stop reason. */
function finishedResult(state: AgentStateValue | undefined): AgentRunResult {
  if (!state?.stopReason) throw new Error('Agent graph ended without a stop reason');
  return {
    messages: state.messages,
    answer: state.answer,
    stopReason: state.stopReason,
    usage: state.usage,
  };
}
