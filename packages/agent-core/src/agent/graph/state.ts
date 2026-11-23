/**
 * The graph's STATE and CONTEXT: the two kinds of data a LangGraph run carries.
 *
 * STATE is the run's memory: everything the agent knows so far (the conversation, the tool menu,
 * counters). Every node reads the whole state and returns only the fields it wants to change (a
 * "partial update"). LangGraph merges that update into the state between steps. In Step 4.3 a
 * checkpointer will save this state after every step, so it must hold plain, JSON-friendly data.
 *
 * CONTEXT is the run's dependencies: the model client, the tool registry, the executor. They are
 * not data about the run, must never be saved in a checkpoint, and differ per tenant. LangGraph
 * passes them to every node as `config.context`, so one compiled graph can serve every run.
 * The person's identity (Step 4.2) is context too, for a security reason: nodes can write state,
 * but context is read-only for the whole run, so no node (and nothing the model says) can change
 * who is asking or which rules apply.
 *
 * How merging works: each field has a CHANNEL. A plain zod field is a "last value" channel: a new
 * value replaces the old one. A `ReducedValue` field has a REDUCER, a function
 * `(current, update) => merged` that LangGraph calls to combine an update with the current value.
 */
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

import type { LLMProvider } from '../../llm/provider.js';
import type { ChatMessage, ToolDefinition } from '../../llm/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { RunAccess } from '../access.js';
import type { ApprovalPolicy } from '../approval.js';
import type { ConversationTurn, SummaryUpdate } from '../conversation.js';
import {
  type AgentLimits,
  type AgentUsage,
  STOP_REASONS,
  addUsage,
  emptyUsage,
} from '../run-types.js';
import type { ToolSelector } from '../tool-selector.js';

/**
 * `z.custom<T>()` tells zod (and so LangGraph) the TypeScript type without checking it at run
 * time. Our message and tool types are already checked where they are made (the LLM adapter and
 * the registry), so checking them again on every step would only cost time.
 */
const chatMessages = z.array(z.custom<ChatMessage>());

export const AgentState = new StateSchema({
  /**
   * The conversation. Reducer = append: a node returns only its NEW messages
   * (`{ messages: [assistantReply] }`) and LangGraph adds them to the end. Without a reducer, a
   * node would have to copy the whole conversation to add one message, and two nodes writing in
   * the same step would overwrite each other.
   */
  messages: new ReducedValue(
    chatMessages.default(() => []),
    {
      reducer: (current, update) => current.concat(update),
    },
  ),

  /**
   * Earlier turns of the conversation and the summary of the ones before them (Step 4.7), as
   * given at the start. `summarizeHistory` may replace them. Kept apart from `messages`, which
   * holds only this run: `callModel` puts them together for each prompt.
   */
  summary: z.string().default(''),
  turns: z.array(z.custom<ConversationTurn>()).default(() => []),

  /** Set when this run summarized older turns, so the platform can save the new summary. */
  summaryUpdate: z.custom<SummaryUpdate>().optional(),

  /** The tool menu, chosen once at the start of the run (last-value channel). */
  tools: z.array(z.custom<ToolDefinition>()).default(() => []),

  /** Token and call counts. Reducer = sum, so each node reports only what it used itself. */
  usage: new ReducedValue(z.custom<AgentUsage>().default(emptyUsage), { reducer: addUsage }),

  /** Model calls made so far. Compared with `maxIterations` to stop a model that never stops. */
  iteration: z.number().default(0),

  /** Failed tool results in a row. Compared with `maxConsecutiveToolErrors`. */
  consecutiveErrors: z.number().default(0),

  /**
   * Set by the node that detects the run should end. The routing functions send the run to
   * `finalize` as soon as this is set. Empty while the run is still going.
   */
  stopReason: z.enum(STOP_REASONS).optional(),

  /** The final answer text, written by `finalize`. */
  answer: z.string().default(''),

  /**
   * What `approvalGate` decided for the latest model turn (Step 4.3). The router after the gate
   * reads it: `approved` or `not_needed` -> run the tools; `rejected` -> back to the model.
   */
  approvalOutcome: z.enum(['not_needed', 'approved', 'rejected']).optional(),
});

/** The full state as nodes see it, inferred from the schema above. */
export type AgentStateValue = typeof AgentState.State;

/** What a node may return: any subset of the fields above. */
export type AgentStateUpdate = typeof AgentState.Update;

/**
 * The run's dependencies (see CONTEXT above). Passed per run with
 * `graph.stream(input, { context: { llm, registry, ... } })`.
 */
export const AgentContext = z.object({
  llm: z.custom<LLMProvider>(),
  registry: z.custom<ToolRegistry>(),
  executor: z.custom<ToolExecutor>(),
  selector: z.custom<ToolSelector>().optional(),
  limits: z.custom<AgentLimits>(),
  /** Who is asking and the rules for them (Step 4.2). Missing means no access control. */
  access: z.custom<RunAccess>().optional(),
  /** Which writes wait for a person (Step 4.3). Missing means no approvals. */
  approvals: z.custom<ApprovalPolicy>().optional(),
});

export type AgentContextValue = z.infer<typeof AgentContext>;
