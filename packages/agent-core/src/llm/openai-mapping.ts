/**
 * Pure translation between our port types and the OpenAI Chat Completions wire format.
 * No network here, so it is tested directly with recorded payloads.
 */
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { assertNever } from '@toolbridge/shared';
import type {
  ChatMessage,
  FinishReason,
  GenerateResult,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from './types.js';

/**
 * Converts our conversation history into the message list the OpenAI API expects.
 * "Wire" means the exact JSON shape sent over the network.
 *
 * Mostly renames fields from our camelCase to OpenAI's snake_case:
 *   { role: 'tool', toolCallId: 'call_1', content }  ->  { role: 'tool', tool_call_id: 'call_1', content }
 *   assistant `toolCalls: [{ id, name, arguments }]`  ->  `tool_calls: [{ id, type: 'function', function: { name, arguments } }]`
 * `tool_calls` is left out when empty, because some servers reject an empty array.
 */
export function toWireMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls.length > 0 && {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      default:
        return assertNever(message);
    }
  });
}

/**
 * Converts our tool definitions into the `tools` field of an OpenAI request.
 * This is the "menu" the model reads to decide which tool to call and with what arguments:
 *   { name, description, parameters }  ->  { type: 'function', function: { name, description, parameters } }
 * `parameters` is a JSON Schema and is passed through unchanged.
 */
export function toWireTools(tools: ToolDefinition[]): ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Converts a whole (non-streamed) OpenAI response back into our GenerateResult.
 * Takes the first choice (we never ask for more than one), turns a null `content` into '',
 * maps each tool call, and renames token counts (prompt_tokens -> inputTokens).
 * Throws if the response has no choices, since there is nothing to answer with.
 */
export function fromWireCompletion(completion: ChatCompletion): GenerateResult {
  const choice = completion.choices[0];
  if (!choice) {
    throw new Error('LLM response had no choices');
  }
  return {
    message: {
      role: 'assistant',
      content: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).map(fromWireToolCall),
    },
    finishReason: toFinishReason(choice.finish_reason),
    ...(completion.usage && { usage: toUsage(completion.usage) }),
  };
}

/**
 * Converts one OpenAI tool call into ours, flattening the nested `function` object:
 *   { id, type: 'function', function: { name, arguments } }  ->  { id, name, arguments }
 * `arguments` stays a raw JSON string; the caller parses and validates it.
 */
function fromWireToolCall(call: ChatCompletionMessageToolCall): ToolCall {
  if (call.type !== 'function') {
    // We only ever send function tools, so a custom tool call means the server misbehaved.
    throw new Error(`Unsupported tool call type: ${call.type}`);
  }
  return { id: call.id, name: call.function.name, arguments: call.function.arguments };
}

/**
 * Narrows OpenAI's finish reason to the few values our code cares about.
 * 'stop' = finished normally, 'tool_calls' = wants tools run, 'length' = hit the token limit.
 * Anything else (content_filter, a missing value, a server-specific value) becomes 'other'.
 */
function toFinishReason(reason: string | null): FinishReason {
  return reason === 'stop' || reason === 'tool_calls' || reason === 'length' ? reason : 'other';
}

/**
 * Renames OpenAI's token counts to ours: prompt_tokens -> inputTokens (what we sent),
 * completion_tokens -> outputTokens (what the model wrote, including thinking).
 */
function toUsage(usage: { prompt_tokens: number; completion_tokens: number }): Usage {
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Joins streamed chunks back into whole messages. A tool call can arrive in pieces that share an
 * `index`: the first carries id and name, the rest append to `arguments`. Ollama sends each call
 * in one chunk, but other servers split it, so we always accumulate.
 */
export class ChunkAccumulator {
  private content = '';
  private readonly partials = new Map<number, PartialToolCall>();
  private finishReason: FinishReason = 'other';
  private usage: Usage | undefined;

  /**
   * Takes one streamed chunk and remembers what it carries: text, tool-call pieces,
   * the finish reason, or usage. Returns only the events that can be sent right away,
   * which is the text piece, if any. Tool calls wait until `finish()`, because their
   * arguments may still be incomplete.
   */
  push(chunk: ChatCompletionChunk): StreamEvent[] {
    if (chunk.usage) {
      this.usage = toUsage(chunk.usage);
    }
    // The final usage chunk has no choices.
    const choice = chunk.choices[0];
    if (!choice) return [];

    if (choice.finish_reason) {
      this.finishReason = toFinishReason(choice.finish_reason);
    }
    for (const delta of choice.delta.tool_calls ?? []) {
      const partial = this.partials.get(delta.index) ?? { id: '', name: '', arguments: '' };
      if (delta.id) partial.id = delta.id;
      if (delta.function?.name) partial.name += delta.function.name;
      if (delta.function?.arguments) partial.arguments += delta.function.arguments;
      this.partials.set(delta.index, partial);
    }
    const text = choice.delta.content;
    if (text) {
      this.content += text;
      return [{ type: 'text-delta', text }];
    }
    return [];
  }

  /**
   * Call once, after the last chunk. Builds the finished tool calls in index order (filling in
   * an id if the server sent none), then returns a `tool-call` event for each one, followed
   * by a final `done` event carrying the whole result.
   */
  finish(): StreamEvent[] {
    const toolCalls = [...this.partials.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, partial]): ToolCall => {
        if (!partial.name) {
          throw new Error(`Streamed tool call at index ${String(index)} has no name`);
        }
        // Some servers omit ids. The tool result must reference one, so make a stable one.
        return { ...partial, id: partial.id || `call_${String(index)}` };
      });
    const result: GenerateResult = {
      message: { role: 'assistant', content: this.content, toolCalls },
      finishReason: this.finishReason,
      ...(this.usage && { usage: this.usage }),
    };
    return [
      ...toolCalls.map((toolCall): StreamEvent => ({ type: 'tool-call', toolCall })),
      { type: 'done', result },
    ];
  }
}
