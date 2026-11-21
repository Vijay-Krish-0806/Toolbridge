/**
 * Kept as a test for two reasons:
 * 1. It guards a permission boundary: with a selector, the model is shown only the selected
 *    tools, and a call to any other registered tool (remembered from earlier in the conversation,
 *    or guessed) is refused without running. Running it would let a write tool slip past
 *    selection, which later steps (RBAC in 4.2) build on.
 * 2. It is the acceptance check for Step 4.1: the LangGraph engine must pass the same cases as
 *    the raw loop, including how a run stops and the progress events a UI sees.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeProvider } from '../llm/fake-provider.js';
import type { GenerateResult } from '../llm/types.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { defineTool } from '../tools/tool.js';
import { runAgentGraph } from './graph/run-graph.js';
import { runAgent } from './loop.js';
import type { AgentEvent, AgentRunInput, AgentRunResult } from './run-types.js';
import type { ToolSelector } from './tool-selector.js';

/** A tool that counts how often it really ran. `fail` makes every run return an error. */
function countingTool(name: string, fail = false) {
  let runs = 0;
  const tool = defineTool({
    name,
    description: `${name} tool`,
    safety: 'write',
    input: z.object({}),
    execute: () => {
      runs++;
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
    },
  });
  return { tool, runs: () => runs };
}

/** A model turn that calls one tool with no arguments. */
const callTool = (name: string): GenerateResult => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name, arguments: '{}' }] },
  finishReason: 'tool_calls',
  usage: { inputTokens: 100, outputTokens: 10 },
});
const answer: GenerateResult = {
  message: { role: 'assistant', content: 'done', toolCalls: [] },
  finishReason: 'stop',
  usage: { inputTokens: 150, outputTokens: 5 },
};

/** Both engines, so every case below runs against each of them. */
const engines: [string, (input: AgentRunInput) => Promise<AgentRunResult>][] = [
  ['raw loop', runAgent],
  ['langgraph', runAgentGraph],
];

/** A run over one tool, with the given scripted model turns. */
function setup(script: GenerateResult[], fail = false) {
  const tool = countingTool('orders_get', fail);
  const registry = new ToolRegistry([tool.tool]);
  const llm = new FakeProvider(script);
  const input: AgentRunInput = {
    llm,
    registry,
    executor: new ToolExecutor(registry),
    messages: [{ role: 'user', content: 'what is ORD-1 doing?' }],
  };
  return { input, llm, tool };
}

describe.each(engines)('%s', (_name, run) => {
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

    const result = await run({
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
    const refusal = result.messages.find((m) => m.role === 'tool');
    expect(refusal?.content).toMatch(/not available for this request/);
    expect(result.stopReason).toBe('answer');
  });

  it('offers every registered tool when there is no selector', async () => {
    const registry = new ToolRegistry([countingTool('a').tool, countingTool('b').tool]);
    const llm = new FakeProvider([answer]);
    await run({
      llm,
      registry,
      executor: new ToolExecutor(registry),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('runs a tool, answers, and reports the conversation and usage', async () => {
    const { input, tool } = setup([callTool('orders_get'), answer]);
    const before = [...input.messages];

    const result = await run(input);

    expect(result).toMatchObject({ answer: 'done', stopReason: 'answer' });
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.usage).toEqual({
      inputTokens: 250,
      outputTokens: 15,
      llmCalls: 2,
      toolCalls: 1,
      lastInputTokens: 150,
    });
    expect(tool.runs()).toBe(1);
    expect(input.messages).toEqual(before); // the caller's conversation is not modified
  });

  it('stops with max_iterations when the model keeps calling tools', async () => {
    const { input, llm } = setup([callTool('orders_get'), callTool('orders_get')]);
    const result = await run({ ...input, limits: { maxIterations: 2 } });
    expect(result).toMatchObject({ answer: '', stopReason: 'max_iterations' });
    expect(llm.requests).toHaveLength(2);
  });

  it('stops with too_many_errors after failures in a row', async () => {
    const { input, llm } = setup([callTool('orders_get'), callTool('orders_get')], true);
    const result = await run({ ...input, limits: { maxConsecutiveToolErrors: 2 } });
    expect(result).toMatchObject({ answer: '', stopReason: 'too_many_errors' });
    expect(llm.requests).toHaveLength(2);
  });

  it('reports length when the answer was cut off at the token limit', async () => {
    const cut: GenerateResult = { ...answer, finishReason: 'length' };
    const { input } = setup([cut]);
    expect(await run(input)).toMatchObject({ answer: 'done', stopReason: 'length' });
  });

  it('with access control, hides forbidden tools and blocks a forced call (Step 4.2)', async () => {
    const lookup = countingTool('orders_get');
    const cancel = countingTool('orders_cancel');
    const registry = new ToolRegistry([lookup.tool, cancel.tool]);
    const allowedSeen: (string[] | undefined)[] = [];
    const selector: ToolSelector = {
      // A selector with a bug: it ignores `allowed` and returns the forbidden tool anyway.
      select: (_query, options) => {
        allowedSeen.push(options?.allowed);
        return Promise.resolve({ names: ['orders_get', 'orders_cancel'], mode: 'top_k' });
      },
    };
    // The model is "forced": it calls the forbidden tool even though it was never offered.
    const llm = new FakeProvider([callTool('orders_cancel'), answer]);
    const authorizer = {
      authorize: (_principal: { role: string }, toolName: string) =>
        toolName === 'orders_cancel'
          ? ({ allowed: false, reason: 'no' } as const)
          : ({ allowed: true } as const),
    };

    const result = await run({
      llm,
      registry,
      // The executor has its own copy of the rules (layer 3), independent of the run's.
      executor: new ToolExecutor(registry, { authorizer }),
      messages: [{ role: 'user', content: 'cancel ORD-1' }],
      selector,
      access: { principal: { userId: 'u1', role: 'warehouse' }, authorizer },
    });

    expect(allowedSeen).toEqual([['orders_get']]);
    for (const request of llm.requests) {
      expect(request.tools?.map((t) => t.name)).toEqual(['orders_get']);
    }
    expect(cancel.runs()).toBe(0);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toMatch(
      /not available for this request/,
    );
  });

  it('streams the same progress events, in order, as the raw loop', async () => {
    /** The event types one engine emits for a tool call followed by an answer. */
    const eventTypes = async (engine: typeof run) => {
      const { input } = setup([callTool('orders_get'), answer]);
      const events: AgentEvent['type'][] = [];
      await engine({ ...input, onEvent: (event) => events.push(event.type) });
      return events;
    };
    expect(await eventTypes(run)).toEqual(await eventTypes(runAgent));
    expect(await eventTypes(run)).toEqual([
      'llm-response',
      'tool-start',
      'tool-end',
      'text-delta',
      'llm-response',
    ]);
  });
});
