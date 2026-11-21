/**
 * A framework-free agent loop (the ReAct pattern): ask the model, run the tools it asks for,
 * append the results, and repeat until it answers in plain text or a limit stops it.
 */
import type { LLMProvider } from '../llm/provider.js';
import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  ToolCall,
  ToolDefinition,
} from '../llm/types.js';
import type { ToolExecutor, ToolResult } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSelection, ToolSelector } from './tool-selector.js';

export interface AgentLimits {
  /** Model calls allowed in one run. The guard against a model that never stops calling tools. */
  maxIterations: number;
  /** Failed tool results in a row before giving up. The retry cap for malformed calls. */
  maxConsecutiveToolErrors: number;
}

const DEFAULT_LIMITS: AgentLimits = { maxIterations: 8, maxConsecutiveToolErrors: 3 };

/**
 * Why the run ended. `answer` is the normal end. The others mean the run was cut short and
 * `answer` may be empty.
 */
export type StopReason = 'answer' | 'max_iterations' | 'too_many_errors' | 'length';

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

export interface AgentRunInput {
  llm: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  /** The conversation so far, ending with the new user message. It is not modified. */
  messages: ChatMessage[];
  limits?: Partial<AgentLimits>;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Step 3.2: offer only the tools this selector picks for the latest user message, instead of
   * every registered tool. Without it, the whole registry is offered (the earlier behavior).
   */
  selector?: ToolSelector;
}

export interface AgentRunResult {
  /** The full conversation after this run, including tool calls and results. */
  messages: ChatMessage[];
  answer: string;
  stopReason: StopReason;
  usage: AgentUsage;
}

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
  const tools = await offeredTools(input, emit);
  const offered = new Set(tools.map((tool) => tool.name));
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    llmCalls: 0,
    toolCalls: 0,
    lastInputTokens: 0,
  };
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

    usage.llmCalls++;
    if (result.usage) {
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.lastInputTokens = result.usage.inputTokens;
    }
    messages.push(result.message);

    const calls = result.message.toolCalls;
    if (calls.length === 0) {
      // A text answer can come at any step: local models cannot be forced to use tools.
      return finish(result.finishReason === 'length' ? 'length' : 'answer', result.message.content);
    }

    const results = await runToolCalls(calls, offered, input.registry, input.executor, emit);
    usage.toolCalls += calls.length;
    calls.forEach((call, i) => {
      const toolResult = results[i];
      if (!toolResult) return;
      messages.push({ role: 'tool', toolCallId: call.id, content: formatToolResult(toolResult) });
      consecutiveErrors = toolResult.ok ? 0 : consecutiveErrors + 1;
    });
    if (consecutiveErrors >= limits.maxConsecutiveToolErrors) {
      return finish('too_many_errors');
    }
  }
  return finish('max_iterations');
}

/**
 * The tool menu for this run. With a selector, it selects once, from the latest user message,
 * and keeps that menu for the whole run: changing the menu between steps would hide a tool the
 * model planned to call next. Names the registry does not know are dropped.
 * Before -> after: 35 registered tools, selector picks 6 -> those 6 definitions, in registry order.
 */
async function offeredTools(
  input: AgentRunInput,
  emit: (event: AgentEvent) => void,
): Promise<ToolDefinition[]> {
  const all = input.registry.definitions();
  if (!input.selector) return all;
  const query = input.messages.findLast((m) => m.role === 'user')?.content ?? '';
  const selection = await input.selector.select(query);
  const picked = new Set(selection.names);
  const tools = all.filter((tool) => picked.has(tool.name));
  emit({ type: 'tools-selected', selection, offered: tools.map((tool) => tool.name) });
  return tools;
}

/**
 * Calls the model in streaming mode. Thinking and text pieces are passed on as events the moment
 * they arrive, so the user sees progress. Returns the complete result from the final `done` event.
 * Tool calls are not emitted here: the loop runs them once the whole turn is known.
 */
async function streamModelTurn(
  llm: LLMProvider,
  request: GenerateRequest,
  emit: (event: AgentEvent) => void,
): Promise<GenerateResult> {
  for await (const event of llm.stream(request)) {
    if (event.type === 'reasoning-delta' || event.type === 'text-delta') emit(event);
    if (event.type === 'done') return event.result;
  }
  throw new Error('Model stream ended without a done event');
}

/**
 * Runs one turn's tool calls and returns their results in the same order as `calls`.
 * Calls from one turn are independent (the model wrote them all before seeing any result), so
 * reads run in parallel. If any call is a write, the batch runs one at a time, in order, so a
 * write never races another call.
 */
async function runToolCalls(
  calls: ToolCall[],
  offered: Set<string>,
  registry: ToolRegistry,
  executor: ToolExecutor,
  emit: (event: AgentEvent) => void,
): Promise<ToolResult[]> {
  /** Runs one call, emitting start and end events around it. */
  const runOne = async (call: ToolCall): Promise<ToolResult> => {
    emit({ type: 'tool-start', call });
    const started = performance.now();
    const result = offered.has(call.name) ? await executor.run(call) : notOffered(call, offered);
    emit({ type: 'tool-end', call, result, durationMs: performance.now() - started });
    return result;
  };

  const hasWrite = calls.some((call) => registry.get(call.name)?.safety === 'write');
  if (!hasWrite) return Promise.all(calls.map(runOne));

  const results: ToolResult[] = [];
  for (const call of calls) results.push(await runOne(call));
  return results;
}

/**
 * The result for a call to a tool that is registered but was not offered in this run (the model
 * remembered it from earlier in the conversation, or guessed its name). It is refused, never run:
 * the menu is the permission boundary for the run, and the model can recover from the error.
 */
function notOffered(call: ToolCall, offered: Set<string>): ToolResult {
  return {
    ok: false,
    error: {
      code: 'unknown_tool',
      message: `Tool "${call.name}" is not available for this request. Available tools: ${[...offered].join(', ')}.`,
      retryable: false,
    },
  };
}

/**
 * Turns a ToolResult into the text of a `tool` message. Success is the tool's JSON. Errors get
 * an "Error" prefix with the code, so the model can tell a failure from data:
 *   { ok: false, error: { code: 'http_error', status: 404, message } }  ->  "Error (http_error 404): ..."
 */
function formatToolResult(result: ToolResult): string {
  if (result.ok) return result.content;
  const { code, status, message } = result.error;
  return `Error (${code}${status === undefined ? '' : ` ${String(status)}`}): ${message}`;
}
