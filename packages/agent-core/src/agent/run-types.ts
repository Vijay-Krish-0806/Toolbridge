/**
 * The contract every agent engine follows. Two engines implement it: the raw loop (`loop.ts`)
 * and the LangGraph graph (`graph/`). Callers such as the CLI and the evals pick one, and get the
 * same input and the same result shape back either way.
 */
import type { LLMProvider } from '../llm/provider.js';
import type { ChatMessage, GenerateResult, ToolCall, Usage } from '../llm/types.js';
import type { ToolExecutor, ToolResult } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { RunAccess } from './access.js';
import type { ApprovalPolicy } from './approval.js';
import type { Exposure } from './exposure.js';
import type { ConversationHistory, SummaryUpdate } from './conversation.js';
import type { ToolSelection, ToolSelector } from './tool-selector.js';

export interface AgentLimits {
  /** Model calls allowed in one run. The guard against a model that never stops calling tools. */
  maxIterations: number;
  /** Failed tool results in a row before giving up. The retry cap for malformed calls. */
  maxConsecutiveToolErrors: number;
  /**
   * Step 4.6: most tokens (input plus output, summed over every model call) one run may use.
   * Unset means no cap. Only the LangGraph engine enforces it; the raw loop is a frozen baseline.
   */
  maxRunTokens?: number;
  /**
   * Step 4.7: the biggest prompt a model call may have (context window minus the output it may
   * write). Older tool results are left out of the prompt to stay under it. Unset = no limit.
   */
  maxPromptTokens?: number;
  /** Step 4.7: history bigger than this is summarized at the start of a run. Unset = never. */
  maxHistoryTokens?: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxIterations: 8, maxConsecutiveToolErrors: 3 };

/**
 * Why the run ended. `answer` is the normal end. The others mean the run was cut short and
 * `answer` may be empty or partial. `token_budget` (Step 4.6): the run's token cap was reached.
 * `context_full` (Step 4.7): the prompt cannot fit the context window, even after trimming.
 * `empty_answer` (ADR 0052): the model ended without any text, also when asked once more.
 */
export type StopReason =
  | 'answer'
  | 'max_iterations'
  | 'too_many_errors'
  | 'length'
  | 'token_budget'
  | 'context_full'
  | 'empty_answer';

/** Every stop reason, for schemas that must list them (the graph state). */
export const STOP_REASONS = [
  'answer',
  'max_iterations',
  'too_many_errors',
  'length',
  'token_budget',
  'context_full',
  'empty_answer',
] as const satisfies readonly StopReason[];

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
  /** Prompt size of the latest model call: how full the context window is right now. */
  lastInputTokens: number;
}

/**
 * Progress events, so a UI (the CLI today) can show what the agent is doing as it happens.
 * `reasoning-delta` and `text-delta` stream while the model writes. `llm-response` follows once
 * that model call is complete.
 */
export type AgentEvent =
  | { type: 'tools-selected'; selection: ToolSelection; offered: string[] }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'llm-response'; iteration: number; result: GenerateResult; durationMs: number }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall; result: ToolResult; durationMs: number };

/** A function that receives progress events. */
export type EmitEvent = (event: AgentEvent) => void;

export interface AgentRunInput {
  llm: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  /** The conversation so far, ending with the new user message. It is not modified. */
  messages: ChatMessage[];
  /**
   * Step 4.7: earlier turns of the conversation, kept apart from `messages` so they can be
   * summarized. Only the LangGraph engine supports it. Without it, `messages` is everything.
   */
  history?: ConversationHistory;
  limits?: Partial<AgentLimits>;
  onEvent?: EmitEvent;
  /**
   * Step 3.2: offer only the tools this selector picks for the latest user message, instead of
   * every registered tool. Without it, the whole registry is offered (the earlier behavior).
   */
  selector?: ToolSelector;
  /**
   * Step 4.2: who is asking and the rules for them. With it, the model is offered only tools the
   * person may use, and each call carries the person to the executor, which checks again.
   * Without it, there is no access control in the agent (tests and local scripts).
   */
  access?: RunAccess;
  /**
   * Step 4.3: rules for which writes wait for a person. Only the LangGraph engine supports it,
   * and only with a checkpointer (a paused run must be saved somewhere). Without it, writes run
   * without approval (tests and local scripts).
   */
  approvals?: ApprovalPolicy;
}

export interface AgentRunResult {
  /** The full conversation after this run, including tool calls and results. */
  messages: ChatMessage[];
  answer: string;
  stopReason: StopReason;
  usage: AgentUsage;
  /** Step 4.7: set when this run summarized older turns; the caller saves it. */
  summaryUpdate?: SummaryUpdate;
  /**
   * Step 4.9: what the model had read by the end, earlier turns included. The caller saves it with
   * the conversation. The raw loop does not track it.
   */
  exposure?: Exposure;
}

/** Usage at the start of a run: all zeros. */
export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, lastInputTokens: 0 };
}

/**
 * The usage of one model call, as an amount to add to the run's totals.
 * Before -> after: `{ inputTokens: 900, outputTokens: 40 }` ->
 * `{ inputTokens: 900, outputTokens: 40, llmCalls: 1, toolCalls: 0, lastInputTokens: 900 }`.
 * With no usage reported, only `llmCalls` is 1.
 */
export function modelCallUsage(usage: Usage | undefined): AgentUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    llmCalls: 1,
    toolCalls: 0,
    lastInputTokens: usage?.inputTokens ?? 0,
  };
}

/**
 * Adds an amount to running totals. Counters are summed. `lastInputTokens` takes the newest
 * value, except when that call reported none (0), which keeps the previous value.
 * Before -> after: `{ inputTokens: 900, llmCalls: 1, ... }` + `{ inputTokens: 1200, llmCalls: 1, ... }`
 * -> `{ inputTokens: 2100, llmCalls: 2, lastInputTokens: 1200, ... }`.
 */
export function addUsage(total: AgentUsage, more: AgentUsage): AgentUsage {
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    llmCalls: total.llmCalls + more.llmCalls,
    toolCalls: total.toolCalls + more.toolCalls,
    lastInputTokens: more.lastInputTokens || total.lastInputTokens,
  };
}

/**
 * The stop reason when the model answered in plain text (no tool calls). A reply cut off at the
 * token limit is reported as `length`, so callers know the answer may be incomplete.
 */
export function answerStopReason(result: GenerateResult): StopReason {
  return result.finishReason === 'length' ? 'length' : 'answer';
}
