/**
 * Provider-neutral message and tool types. The agent loop speaks only these;
 * each adapter translates them to and from its own wire format.
 */

/** A JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * A tool call requested by the model. `arguments` stays the raw JSON string the model wrote:
 * small models sometimes emit invalid JSON, and the caller must be able to send that error back.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
}

/** The result of running a tool, linked to the call that asked for it. */
export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface GenerateRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

/** Why the model stopped. Don't use it to detect tool calls: check `message.toolCalls` instead. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  message: AssistantMessage;
  finishReason: FinishReason;
  /** Missing when the server does not report token counts. */
  usage?: Usage;
}

/**
 * Events from a streamed generation. Text arrives in pieces. Each tool call arrives once, whole,
 * after the adapter has joined its pieces. `done` always comes last and carries the full result.
 * `reasoning-delta` is the model's "thinking" text, for display only: it is never part of the
 * answer and is not sent back to the model.
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'done'; result: GenerateResult };
