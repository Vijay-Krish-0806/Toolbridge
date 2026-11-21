/**
 * The building blocks both agent engines share: pick the tool menu, call the model, run tools,
 * and turn results into messages. The raw loop and the LangGraph graph call these same functions;
 * they differ only in how they wire the steps together. That keeps the comparison in ADR 0025 fair.
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
import type { EmitEvent } from './run-types.js';
import type { ToolSelector } from './tool-selector.js';

/**
 * The tool menu for this run. With a selector, it selects once, from the latest user message,
 * and keeps that menu for the whole run: changing the menu between steps would hide a tool the
 * model planned to call next. Names the registry does not know are dropped.
 * Before -> after: 35 registered tools, selector picks 6 -> those 6 definitions, in registry order.
 */
export async function selectToolMenu(
  registry: ToolRegistry,
  selector: ToolSelector | undefined,
  messages: ChatMessage[],
  emit: EmitEvent,
): Promise<ToolDefinition[]> {
  const all = registry.definitions();
  if (!selector) return all;
  const query = messages.findLast((m) => m.role === 'user')?.content ?? '';
  const selection = await selector.select(query);
  const picked = new Set(selection.names);
  const tools = all.filter((tool) => picked.has(tool.name));
  emit({ type: 'tools-selected', selection, offered: tools.map((tool) => tool.name) });
  return tools;
}

/**
 * Calls the model in streaming mode. Thinking and text pieces are passed on as events the moment
 * they arrive, so the user sees progress. Returns the complete result from the final `done` event.
 * Tool calls are not emitted here: the engine runs them once the whole turn is known.
 */
export async function streamModelTurn(
  llm: LLMProvider,
  request: GenerateRequest,
  emit: EmitEvent,
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
 * write never races another call. A call to a tool outside `offered` is refused, never run.
 */
export async function runToolCalls(
  calls: ToolCall[],
  offered: ReadonlySet<string>,
  registry: ToolRegistry,
  executor: ToolExecutor,
  emit: EmitEvent,
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
function notOffered(call: ToolCall, offered: ReadonlySet<string>): ToolResult {
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
 * Turns a turn's results into `tool` messages, paired with their calls by position, and counts
 * the errors in a row that end the batch.
 * Before -> after: calls [c1, c2], results [ok, error], previous streak 0 ->
 * `{ messages: [tool c1, tool c2 "Error (...)"], consecutiveErrors: 1 }`. A success resets the streak.
 */
export function toolResultMessages(
  calls: ToolCall[],
  results: ToolResult[],
  previousErrors: number,
): { messages: ChatMessage[]; consecutiveErrors: number } {
  const messages: ChatMessage[] = [];
  let consecutiveErrors = previousErrors;
  calls.forEach((call, i) => {
    const result = results[i];
    if (!result) return;
    messages.push({ role: 'tool', toolCallId: call.id, content: formatToolResult(result) });
    consecutiveErrors = result.ok ? 0 : consecutiveErrors + 1;
  });
  return { messages, consecutiveErrors };
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
