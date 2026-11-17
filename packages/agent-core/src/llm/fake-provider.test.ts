import { describe, expect, it } from 'vitest';

import { FakeProvider } from './fake-provider.js';
import type { GenerateResult, StreamEvent } from './types.js';

const toolCallTurn: GenerateResult = {
  message: {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'get_order', arguments: '{"orderId":"ORD-1"}' }],
  },
  finishReason: 'tool_calls',
};
const answerTurn: GenerateResult = {
  message: { role: 'assistant', content: 'Order ORD-1 has  shipped.', toolCalls: [] },
  finishReason: 'stop',
};

describe('FakeProvider', () => {
  it('returns scripted results in order and records each request', async () => {
    const llm = new FakeProvider([toolCallTurn, answerTurn]);
    const request = { messages: [{ role: 'user' as const, content: 'Status of ORD-1?' }] };

    await expect(llm.generate(request)).resolves.toBe(toolCallTurn);
    await expect(llm.generate(request)).resolves.toBe(answerTurn);
    expect(llm.requests).toEqual([request, request]);
    await expect(llm.generate(request)).rejects.toThrow('script exhausted');
  });

  it('streams text in pieces that join back exactly, then tool calls, then done', async () => {
    const llm = new FakeProvider([answerTurn, toolCallTurn]);
    // Reads one whole stream from the fake provider into an array.
    const collect = async (): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      for await (const event of llm.stream({ messages: [] })) events.push(event);
      return events;
    };

    const textEvents = await collect();
    const text = textEvents.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('');
    expect(text).toBe(answerTurn.message.content);
    expect(textEvents.at(-1)).toEqual({ type: 'done', result: answerTurn });

    expect(await collect()).toEqual([
      { type: 'tool-call', toolCall: toolCallTurn.message.toolCalls[0] },
      { type: 'done', result: toolCallTurn },
    ]);
  });
});
