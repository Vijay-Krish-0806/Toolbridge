/**
 * Step 4.7 acceptance check: long conversations stay within context. A test, not a command: the
 * local model would need hours for it, and the data-integrity rule (a tool call is never separated
 * from its result) must hold for every prompt, not for the few a live run happens to make.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LLMProvider } from '../../llm/provider.js';
import type { ChatMessage, GenerateRequest, GenerateResult, StreamEvent } from '../../llm/types.js';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import { defineTool } from '../../tools/tool.js';
import { CLEARED_RESULT, clipText, estimatePrompt, estimateTokens } from '../context-window.js';
import { type ConversationHistory, historyMessages, splitHistory } from '../conversation.js';
import { runAgentGraph } from './run-graph.js';

const MAX_PROMPT = 4000;
const MAX_HISTORY = 800;

const text = (content: string): GenerateResult => ({
  message: { role: 'assistant', content, toolCalls: [] },
  finishReason: 'stop',
});

/**
 * A model that asks for `rounds` rounds of two lookups per run and then answers. A request with
 * thinking off is a summary request. It records every prompt it was sent.
 */
class ChattyModel implements LLMProvider {
  readonly prompts: GenerateRequest[] = [];
  readonly summaries: GenerateRequest[] = [];
  private calls = 0;

  constructor(
    private readonly rounds: number,
    private readonly summary: (n: number) => string = (n) => `summary ${String(n)}`,
  ) {}

  generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.reasoning === 'off') {
      this.summaries.push(request);
      return Promise.resolve(text(this.summary(this.summaries.length)));
    }
    this.prompts.push(request);
    const done = request.messages.filter(
      (m) => m.role === 'assistant' && m.toolCalls.length > 0,
    ).length;
    if (done >= this.rounds) return Promise.resolve(text(`It is fine. ${'Details. '.repeat(30)}`));
    const call = (n: number) => ({
      id: `c${String(++this.calls)}`,
      name: 'orders_list',
      arguments: JSON.stringify({ page: n }),
    });
    return Promise.resolve({
      message: { role: 'assistant', content: '', toolCalls: [call(1), call(2)] },
      finishReason: 'tool_calls',
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', result: await this.generate(request) };
  }
}

/** A registry whose one tool returns about 2,000 estimated tokens of JSON (two per turn: more than fits). */
function bigTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'orders_list',
      description: 'List orders',
      safety: 'read',
      input: z.looseObject({}),
      execute: () =>
        Promise.resolve({
          items: Array.from({ length: 120 }, (_, i) => ({ number: `ORD-${String(10000 + i)}` })),
        }),
    }),
  );
  return registry;
}

/** One run, as the platform makes it: the new message, and the history so far. */
function run(
  llm: LLMProvider,
  message: string,
  history: ConversationHistory,
  maxRunTokens?: number,
) {
  const registry = bigTool();
  return runAgentGraph({
    llm,
    registry,
    executor: new ToolExecutor(registry),
    messages: [
      { role: 'system', content: 'You are a store assistant.' },
      { role: 'user', content: message },
    ],
    history,
    limits: {
      maxPromptTokens: MAX_PROMPT,
      maxHistoryTokens: MAX_HISTORY,
      ...(maxRunTokens !== undefined && { maxRunTokens }),
    },
  });
}

/** Every assistant tool call is followed by its result, and no result is without its call. */
function expectPaired(messages: ChatMessage[]): void {
  let open: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      expect(open).toContain(message.toolCallId);
      open = open.filter((id) => id !== message.toolCallId);
    } else {
      expect(open).toEqual([]); // nothing may come between a call and its results
      if (message.role === 'assistant') open = message.toolCalls.map((call) => call.id);
    }
  }
  expect(open).toEqual([]);
}

describe('a long conversation', () => {
  it('keeps every prompt of 40 turns within the limit, valid, and with the system prompt', async () => {
    const llm = new ChattyModel(3);
    let history: ConversationHistory = { summary: '', turns: [] };
    for (let turn = 1; turn <= 40; turn++) {
      const message = `Question ${String(turn)} about the orders?`;
      const result = await run(llm, message, history);
      expect(result.stopReason).toBe('answer');
      // What the platform does after a run: save the new summary, forget the turns it covers.
      const { summaryUpdate } = result;
      const covered = summaryUpdate
        ? history.turns.findIndex((t) => t.id === summaryUpdate.throughTurnId) + 1
        : 0;
      history = {
        summary: summaryUpdate?.summary ?? history.summary,
        turns: [
          ...history.turns.slice(covered),
          { id: String(turn), user: message, answer: result.answer },
        ],
      };
    }

    for (const prompt of llm.prompts) {
      expect(estimatePrompt(prompt.messages, prompt.tools ?? [])).toBeLessThanOrEqual(MAX_PROMPT);
      expect(prompt.messages[0]).toMatchObject({ role: 'system' });
      expectPaired(prompt.messages);
    }
    // Both kinds of trimming were really needed: older results removed, latest ones cut.
    const contents = llm.prompts.flatMap((p) => p.messages.map((m) => m.content));
    expect(contents).toContain(CLEARED_RESULT);
    expect(contents.some((c) => c.endsWith('[cut to fit]'))).toBe(true);
    // 40 runs of 4 calls each. Summaries are needed, but not on every turn.
    expect(llm.prompts).toHaveLength(160);
    expect(llm.summaries.length).toBeGreaterThan(3);
    expect(llm.summaries.length).toBeLessThan(20);
    // The last run still saw the newest earlier turn word for word, and the summary as user data.
    const last = llm.prompts.at(-1)?.messages ?? [];
    expect(last.some((m) => m.role === 'user' && m.content.startsWith('Question 39'))).toBe(true);
    expect(last[1]).toMatchObject({ role: 'user' });
    expect(last[1]?.content).toContain(`summary ${String(llm.summaries.length)}`);
  });

  it('leaves the saved conversation untouched: only the prompt is trimmed', async () => {
    const llm = new ChattyModel(3);
    const result = await run(llm, 'List them', { summary: '', turns: [] });
    const lastPrompt = llm.prompts.at(-1)?.messages ?? [];
    expect(lastPrompt.some((m) => m.content === CLEARED_RESULT)).toBe(true);
    expect(result.messages.some((m) => m.content === CLEARED_RESULT)).toBe(false);
  });
});

describe('summaries', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    id: `t${String(i)}`,
    user: `question ${String(i)}`,
    answer: 'A long answer. '.repeat(15),
  }));

  it('an empty summary saves nothing, so the turns are not lost for later runs', async () => {
    const result = await run(new ChattyModel(0, () => ''), 'next', { summary: 'old', turns });
    expect(result.stopReason).toBe('answer');
    expect(result.summaryUpdate).toBeUndefined();
  });

  it('counts the summary call in the usage, and skips it when the budget has no room', async () => {
    const paid = new ChattyModel(0);
    const result = await run(paid, 'next', { summary: '', turns });
    expect(paid.summaries).toHaveLength(1);
    expect(result.usage.llmCalls).toBe(2);

    const poor = new ChattyModel(0);
    const skipped = await run(poor, 'next', { summary: '', turns }, 600);
    expect(poor.summaries).toHaveLength(0);
    expect(skipped.summaryUpdate).toBeUndefined();
  });

  it('always keeps the newest turn, cut when it is huge', () => {
    const huge = { id: 'x', user: 'u '.repeat(4000), answer: 'a '.repeat(4000) };
    const split = splitHistory({ summary: '', turns: [...turns, huge] }, MAX_HISTORY);
    expect(split?.recent.map((t) => t.id)).toEqual(['x']);
    expect(split?.older).toHaveLength(12);
    const size = historyMessages({ summary: '', turns: split?.recent ?? [] });
    expect(estimatePrompt(size, [])).toBeLessThanOrEqual(MAX_HISTORY);
  });
});

describe('a prompt that cannot fit', () => {
  it('stops with context_full instead of sending it', async () => {
    const llm = new ChattyModel(0);
    const result = await run(llm, 'x9'.repeat(4000), { summary: '', turns: [] });
    expect(result.stopReason).toBe('context_full');
    expect(llm.prompts).toHaveLength(0);
  });
});

describe('token estimates', () => {
  it('are never far below what the real tokenizer counted (measured 2026-11-23)', () => {
    // [text, tokens counted by the local model's server, without the 11 of the message around it]
    const measured: [string, number][] = [
      ['我的订单还没有到，请告诉我什么时候送达。'.repeat(30), 299],
      ['😀🎉🚚📦'.repeat(60), 599],
      ['{"a":[],"b":{}},'.repeat(150), 1050],
      ['~!@#$%^&*()_+|}{":?><'.repeat(60), 839],
    ];
    for (const [sample, real] of measured) {
      expect(estimateTokens(sample) * 1.1).toBeGreaterThanOrEqual(real);
    }
  });

  it('clipText keeps the start and fits', () => {
    const clipped = clipText('word '.repeat(2000), 100);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(100);
    expect(clipped.startsWith('word word')).toBe(true);
    expect(clipped.endsWith('[cut to fit]')).toBe(true);
  });
});
