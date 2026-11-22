/**
 * Step 4.6 acceptance check: a run stops CLEANLY at its token cap. A test, not a command, because
 * it is about money and safety limits, and a local model is too slow and too random to hit a cap
 * at an exact point. A scripted model reports fixed token counts, so every number is known.
 * "Cleanly" means: a normal finish with `stopReason: 'token_budget'`, no call that cannot fit is
 * started, the tools of the last reply do not run, and the partial text is kept.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeProvider } from '../../llm/fake-provider.js';
import { costMicroUsd, parsePriceTable, priceOf } from '../../llm/pricing.js';
import type { GenerateResult, ToolCall } from '../../llm/types.js';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import { defineTool } from '../../tools/tool.js';
import { runAgentGraph } from './run-graph.js';

const lookup: ToolCall = { id: 'c1', name: 'orders_get', arguments: '{"number":"ORD-7"}' };

/** A model reply asking for one tool, with the token counts the server would report. */
const toolTurn = (inputTokens: number, outputTokens: number): GenerateResult => ({
  message: { role: 'assistant', content: 'Checking.', toolCalls: [lookup] },
  finishReason: 'tool_calls',
  usage: { inputTokens, outputTokens },
});

/** Runs the graph with a counting read tool and a token cap. */
async function run(script: GenerateResult[], maxRunTokens: number) {
  let toolRuns = 0;
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'orders_get',
      description: 'Get an order',
      safety: 'read',
      input: z.looseObject({}),
      execute: () => {
        toolRuns++;
        return Promise.resolve({ status: 'shipped' });
      },
    }),
  );
  const llm = new FakeProvider(script);
  const result = await runAgentGraph({
    llm,
    registry,
    executor: new ToolExecutor(registry),
    messages: [{ role: 'user', content: 'Where is ORD-7?' }],
    limits: { maxRunTokens },
  });
  return { result, requests: llm.requests, toolRuns: () => toolRuns };
}

describe('token budget', () => {
  it('limits a call to what is left, then stops before a call that cannot fit', async () => {
    // Cap 7,000. Call 1 uses 3,000 + 100: the follow-up needs >= 3,100 more, 800 left -> tools run.
    // Call 2 may write at most 7,000 - 3,100 - 3,000 = 900 tokens. It uses 3,500 + 100 (6,700 in
    // all): the follow-up needs >= 3,600, which cannot fit -> stop now, tools not run.
    const { result, requests, toolRuns } = await run(
      [toolTurn(3000, 100), toolTurn(3500, 100), toolTurn(1, 1)],
      7000,
    );

    expect(result.stopReason).toBe('token_budget');
    expect(requests).toHaveLength(2); // the third scripted reply is never asked for
    expect(requests[0]?.maxOutputTokens).toBe(7000);
    expect(requests[1]?.maxOutputTokens).toBe(900);
    expect(toolRuns()).toBe(1); // only the first turn's tool ran
    expect(result.usage).toMatchObject({ inputTokens: 6500, outputTokens: 200, llmCalls: 2 });
    expect(result.answer).toBe('Checking.');
  });

  it('keeps the partial text of a reply cut off by the budget', async () => {
    const cut: GenerateResult = {
      message: { role: 'assistant', content: 'ORD-7 shipped on', toolCalls: [] },
      finishReason: 'length',
      usage: { inputTokens: 900, outputTokens: 100 },
    };
    const { result } = await run([cut], 1000);

    expect(result.stopReason).toBe('token_budget');
    expect(result.answer).toBe('ORD-7 shipped on');
  });

  it('makes no model call when the cap leaves no room for an answer', async () => {
    const { result, requests } = await run([toolTurn(1, 1)], 100);

    expect(result.stopReason).toBe('token_budget');
    expect(requests).toHaveLength(0);
    expect(result.usage.llmCalls).toBe(0);
  });
});

describe('cost', () => {
  it('prices calls in whole micro-dollars and refuses unpriced models', () => {
    const table = parsePriceTable({
      models: {
        paid: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
        local: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      },
    });

    expect(costMicroUsd(priceOf(table, 'paid'), { inputTokens: 1000, outputTokens: 200 })).toBe(
      6000,
    );
    expect(costMicroUsd(priceOf(table, 'local'), { inputTokens: 1000, outputTokens: 200 })).toBe(0);
    expect(() => priceOf(table, 'unknown')).toThrow(/No price for model "unknown"/);
    expect(() =>
      parsePriceTable({ models: { m: { inputUsdPerMtok: 1, outputUsdPerMTok: 1 } } }),
    ).toThrow();
  });
});
