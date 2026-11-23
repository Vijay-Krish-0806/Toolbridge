/**
 * Step 4.7: keeping every prompt inside the model's CONTEXT WINDOW, as pure functions.
 *
 * Why it matters: a local server does not refuse a prompt that is too long. Ollama silently drops
 * part of it (BUILD_PLAN 1.1). So the size is checked here, before every call.
 *
 * The functions return a VIEW: a trimmed copy for one model call. The saved conversation is never
 * changed, so checkpoints, approvals and the audit trail keep the full record.
 *
 * Why not LangChain's `trimMessages`: it drops whole messages. Inside one run there is a single
 * user message, so (measured on @langchain/core 1.4.1) it returned an empty list, or kept a tool
 * result whose call was gone. Replacing the CONTENT of old tool results keeps every call with its
 * result, so the list stays valid by construction.
 */
import type { ChatMessage, ToolDefinition } from '../llm/types.js';

/** Put in place of a tool result that was left out of the view. */
export const CLEARED_RESULT =
  '[This older result was removed to save space. Call the tool again if you need it.]';

/** Appended to text that was cut to fit. */
const CUT_MARK = '\n[cut to fit]';

/** Tokens the chat format adds around each message (measured: about 5). */
const MESSAGE_OVERHEAD = 6;

/** Room for what the estimate misses: a prompt is kept under `limit / SAFETY`. */
const SAFETY = 1.1;

/** Runs of letters and digits that contain a digit: ids, dates, amounts, order numbers. */
const ID_LIKE = /[A-Za-z]*\d[A-Za-z\d]*/g;
const PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** Characters outside the basic plane (emoji and rare scripts); each is 2 units of `length`. */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu;
const NON_ASCII = /[^ -~\s]/g;

/** How many characters of `text` match. */
function count(text: string, pattern: RegExp): number {
  let length = 0;
  for (const match of text.matchAll(pattern)) length += match[0].length;
  return length;
}

/**
 * Estimates the tokens of a text without a tokenizer, on the high side. Measured on the local
 * model (2026-11-23), in characters per token: English 4.6, tool definitions 3.3, JSON results
 * 2.0, object ids 1.0, Hindi 2.2, punctuation 1.5 to 2; an emoji is about 2.5 tokens. So the
 * usual "4 characters per token" is wrong by a factor of 2 to 4 for tool data. The rule follows
 * those numbers: id-like words 1 token per character, punctuation 2 per 3, other non-ASCII text
 * 1 per 2, emoji 3 each, and the rest 1 per 3.
 * Before -> after: 'delivered' -> 3; 'ORD-10007' -> 7 (5 for '10007', under 1 for '-', 1 for 'ORD').
 */
export function estimateTokens(text: string): number {
  const ids = count(text, ID_LIKE);
  const punctuation = count(text, PUNCTUATION);
  const astral = count(text, ASTRAL);
  const nonAscii = count(text, NON_ASCII) - astral;
  const rest = text.length - ids - punctuation - astral - nonAscii;
  return Math.ceil(ids + (punctuation * 2) / 3 + nonAscii / 2 + astral * 1.5 + rest / 3);
}

/** The estimated size of one message, with its tool calls and the chat format around it. */
export function estimateMessage(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD + estimateTokens(message.content);
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) {
      tokens += MESSAGE_OVERHEAD + estimateTokens(call.name) + estimateTokens(call.arguments);
    }
  }
  return tokens;
}

/**
 * The estimated size of the tool menu. Mostly English inside JSON, measured at 3.3 characters per
 * token, so it has its own rate: the rule for JSON data would count it half as big again, and a
 * 35-tool menu would then seem to fill the window.
 */
function estimateTools(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  const json = JSON.stringify(tools);
  return Math.ceil(json.length / 3 + count(json, NON_ASCII) / 2);
}

/** The estimated size of a whole prompt: every message plus the tool menu. */
export function estimatePrompt(messages: ChatMessage[], tools: ToolDefinition[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), estimateTools(tools));
}

/**
 * Cuts a text to about `maxTokens`, keeping its start and marking the cut.
 * Before -> after: (3,000 tokens of text, 100) -> the first ~100 tokens + "[cut to fit]".
 */
export function clipText(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // Binary search for the longest start that fits: the estimate only grows with length.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle) + CUT_MARK) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + CUT_MARK;
}

/** A prompt that fits, and its estimated size. */
export interface FittedPrompt {
  messages: ChatMessage[];
  estimatedTokens: number;
  /** True when something was left out or cut. */
  trimmed: boolean;
}

/**
 * The view of `messages` that fits into `maxPromptTokens`, or `null` when nothing can make it fit
 * (the system prompt, the tool menu and the user's message alone are too big).
 * 1. Fits already -> returned unchanged.
 * 2. Tool results from EARLIER turns are replaced by a short note, oldest first, until it fits.
 * 3. Still too big -> the latest turn's results are cut to equal shares of the room that is left.
 *    The start is kept: list results put their paging hints first (ADR 0016).
 * Before -> after: [system, user, call 1, result 1 (4,000), call 2, result 2 (4,000)] with room
 * for 5,000 -> the same six messages, with result 1 replaced by CLEARED_RESULT.
 */
export function fitMessages(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxPromptTokens: number | undefined,
): FittedPrompt | null {
  const view = [...messages];
  let size = estimatePrompt(view, tools);
  if (maxPromptTokens === undefined)
    return { messages: view, estimatedTokens: size, trimmed: false };
  const limit = Math.floor(maxPromptTokens / SAFETY);

  let trimmed = false;
  /** Replaces one tool result in the view and keeps `size` in step. */
  const replace = (index: number, content: string): void => {
    const message = view[index];
    if (message?.role !== 'tool') return;
    const smaller: ChatMessage = { ...message, content };
    size += estimateMessage(smaller) - estimateMessage(message);
    view[index] = smaller;
    trimmed = true;
  };

  const lastAssistant = view.findLastIndex((message) => message.role === 'assistant');
  const results = view.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
  const cleared = estimateTokens(CLEARED_RESULT);

  for (const index of results.filter((i) => i < lastAssistant)) {
    if (size <= limit) break;
    if (estimateTokens(view[index]?.content ?? '') > cleared) replace(index, CLEARED_RESULT);
  }
  if (size > limit) {
    const latest = results.filter((i) => i > lastAssistant);
    const current = latest.reduce((sum, i) => sum + estimateTokens(view[i]?.content ?? ''), 0);
    const share = Math.floor((limit - (size - current)) / Math.max(1, latest.length));
    if (share < cleared) return null;
    for (const index of latest) replace(index, clipText(view[index]?.content ?? '', share));
  }
  return size <= limit ? { messages: view, estimatedTokens: size, trimmed } : null;
}
