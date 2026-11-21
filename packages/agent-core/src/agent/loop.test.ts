/**
 * Kept as a test because it guards a permission boundary: with a selector, the model is shown
 * only the selected tools, and a call to any other registered tool (remembered from earlier in
 * the conversation, or guessed) is refused without running. Running it would let a write tool
 * slip past selection, which later steps (RBAC in 4.2) build on.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeProvider } from '../llm/fake-provider.js';
import type { GenerateResult } from '../llm/types.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { defineTool } from '../tools/tool.js';
import { runAgent } from './loop.js';
import type { ToolSelector } from './tool-selector.js';

/** A tool that counts how often it really ran. */
function countingTool(name: string) {
  let runs = 0;
  const tool = defineTool({
    name,
    description: `${name} tool`,
    safety: 'write',
    input: z.object({}),
    execute: () => {
      runs++;
      return Promise.resolve({ ok: true });
    },
  });
  return { tool, runs: () => runs };
}

/** A model turn that calls one tool with no arguments. */
const callTool = (name: string): GenerateResult => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name, arguments: '{}' }] },
  finishReason: 'tool_calls',
});
const answer: GenerateResult = {
  message: { role: 'assistant', content: 'done', toolCalls: [] },
  finishReason: 'stop',
};

describe('runAgent with a tool selector', () => {
  it('offers only selected tools and refuses a call to any other tool', async () => {
    const lookup = countingTool('orders_get');
    const cancel = countingTool('orders_cancel');
    const registry = new ToolRegistry([lookup.tool, cancel.tool]);
    const queries: string[] = [];
    const selector: ToolSelector = {
      select: (query) => {
        queries.push(query);
        return Promise.resolve({ names: ['orders_get', 'not_a_tool'], mode: 'top_k' });
      },
    };
    const llm = new FakeProvider([callTool('orders_cancel'), answer]);

    const run = await runAgent({
      llm,
      registry,
      executor: new ToolExecutor(registry),
      messages: [{ role: 'user', content: 'what is ORD-1 doing?' }],
      selector,
    });

    expect(queries).toEqual(['what is ORD-1 doing?']);
    // Every model call saw the same menu: the selected tool that exists, nothing else.
    for (const request of llm.requests) {
      expect(request.tools?.map((t) => t.name)).toEqual(['orders_get']);
    }
    expect(cancel.runs()).toBe(0);
    const refusal = run.messages.find((m) => m.role === 'tool');
    expect(refusal?.content).toMatch(/not available for this request/);
    expect(run.stopReason).toBe('answer');
  });

  it('offers every registered tool when there is no selector', async () => {
    const registry = new ToolRegistry([countingTool('a').tool, countingTool('b').tool]);
    const llm = new FakeProvider([answer]);
    await runAgent({
      llm,
      registry,
      executor: new ToolExecutor(registry),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
