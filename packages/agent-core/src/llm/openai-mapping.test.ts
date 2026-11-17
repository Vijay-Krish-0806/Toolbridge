import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { ChunkAccumulator, fromWireCompletion, toWireMessages } from './openai-mapping.js';
import type { StreamEvent } from './types.js';

type Delta = ChatCompletionChunk.Choice.Delta;
type WireFinishReason = ChatCompletionChunk.Choice['finish_reason'];

/** Builds a minimal streamed chunk around `delta`, so tests only spell out the part that matters. */
function chunk(delta: Delta, finishReason: WireFinishReason = null): ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Feeds chunks through a fresh accumulator, like a real stream would, and collects every event. */
function runStream(chunks: ChatCompletionChunk[]): StreamEvent[] {
  const accumulator = new ChunkAccumulator();
  return [...chunks.flatMap((c) => accumulator.push(c)), ...accumulator.finish()];
}

describe('toWireMessages', () => {
  it('maps a tool-calling conversation to the OpenAI format', () => {
    const wire = toWireMessages([
      { role: 'user', content: 'Status of ORD-1?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_order', arguments: '{"orderId":"ORD-1"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"status":"shipped"}' },
      { role: 'assistant', content: 'It shipped.', toolCalls: [] },
    ]);

    expect(wire).toEqual([
      { role: 'user', content: 'Status of ORD-1?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_order', arguments: '{"orderId":"ORD-1"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
      // No empty tool_calls array: some servers reject it.
      { role: 'assistant', content: 'It shipped.' },
    ]);
  });
});

describe('fromWireCompletion', () => {
  it('maps the response Ollama returned in the smoke test', () => {
    const completion = {
      id: 'chatcmpl-246',
      object: 'chat.completion',
      created: 0,
      model: 'toolbridge-qwen3.5-4b-16k',
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            refusal: null,
            tool_calls: [
              {
                id: 'call_8kxgwivr',
                type: 'function',
                function: { name: 'get_order', arguments: '{"orderId":"ORD-1001"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 318, completion_tokens: 119, total_tokens: 437 },
    } satisfies ChatCompletion;

    expect(fromWireCompletion(completion)).toEqual({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_8kxgwivr', name: 'get_order', arguments: '{"orderId":"ORD-1001"}' },
        ],
      },
      finishReason: 'tool_calls',
      usage: { inputTokens: 318, outputTokens: 119 },
    });
  });
});

describe('ChunkAccumulator', () => {
  it('joins tool calls whose arguments arrive in pieces, keyed by index', () => {
    // Fragmented the way OpenAI streams it: id and name first, then argument pieces.
    const events = runStream([
      chunk({ role: 'assistant', content: 'Checking ' }),
      chunk({ content: 'both.' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'get_order', arguments: '' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'get_customer', arguments: '{"cust' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"orderId":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: 'omerId":"C-9"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ORD-1"}' } }] }),
      chunk({}, 'tool_calls'),
      {
        ...chunk({}),
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      },
    ]);

    const getOrder = { id: 'call_a', name: 'get_order', arguments: '{"orderId":"ORD-1"}' };
    const getCustomer = { id: 'call_b', name: 'get_customer', arguments: '{"customerId":"C-9"}' };
    expect(events).toEqual([
      { type: 'text-delta', text: 'Checking ' },
      { type: 'text-delta', text: 'both.' },
      { type: 'tool-call', toolCall: getOrder },
      { type: 'tool-call', toolCall: getCustomer },
      {
        type: 'done',
        result: {
          message: {
            role: 'assistant',
            content: 'Checking both.',
            toolCalls: [getOrder, getCustomer],
          },
          finishReason: 'tool_calls',
          usage: { inputTokens: 50, outputTokens: 20 },
        },
      },
    ]);
  });

  it('handles a whole tool call in one chunk, as Ollama sends it', () => {
    const events = runStream([
      chunk({
        content: '',
        tool_calls: [
          {
            id: 'call_l6p15ba0',
            index: 0,
            type: 'function',
            function: { name: 'get_order', arguments: '{"orderId":"ORD-1001"}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    ]);

    expect(events).toEqual([
      {
        type: 'tool-call',
        toolCall: { id: 'call_l6p15ba0', name: 'get_order', arguments: '{"orderId":"ORD-1001"}' },
      },
      expect.objectContaining({ type: 'done' }),
    ]);
  });

  it('gives a stable id to a tool call that arrives without one', () => {
    const events = runStream([
      chunk({ tool_calls: [{ index: 0, function: { name: 'list_products', arguments: '{}' } }] }),
    ]);

    expect(events[0]).toEqual({
      type: 'tool-call',
      toolCall: { id: 'call_0', name: 'list_products', arguments: '{}' },
    });
  });
});
