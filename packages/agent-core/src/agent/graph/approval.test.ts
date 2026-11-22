/**
 * REQUIRED test (BUILD_PLAN section 4, approvals): no write executes before approval, and
 * resuming never executes the same write twice. Also pins the rest of the gate's contract:
 * all-or-nothing batches, rejection, self-approval of high-risk actions, malformed answers, and
 * engines that cannot pause refusing approval rules instead of ignoring them.
 * Uses LangGraph's in-memory checkpointer; the same checks run against MongoDB in
 * packages/checkpoint-mongo (a real restart there means a new saver on the same database).
 */
import { Command, MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeProvider } from '../../llm/fake-provider.js';
import type { GenerateResult, ToolCall } from '../../llm/types.js';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import { defineTool } from '../../tools/tool.js';
import type { ApprovalLevel, ApprovalPolicy } from '../approval.js';
import { runAgent } from '../loop.js';
import { buildAgentGraph } from './build-graph.js';
import { resumeAgentRun, runAgentGraph, startAgentRun } from './run-graph.js';

/** A tool that counts how often it really ran. */
function countingTool(name: string, safety: 'read' | 'write') {
  let runs = 0;
  const tool = defineTool({
    name,
    description: `${name} tool`,
    safety,
    input: z.looseObject({}),
    execute: () => {
      runs++;
      return Promise.resolve({ ok: true });
    },
  });
  return { tool, runs: () => runs };
}

/** Test rules: refunds are high risk, other writes need plain approval, reads need nothing. */
const approvals: ApprovalPolicy = {
  evaluate: (calls) => {
    const levels = calls.map((c) => {
      if (c.safety === 'read') return 'none' as const;
      return c.name === 'refunds_request' ? ('high' as const) : ('required' as const);
    });
    const order = { none: 0, required: 1, high: 2 } as const;
    const level = levels.reduce<ApprovalLevel>((a, b) => (order[b] > order[a] ? b : a), 'none');
    return { level, calls: levels.map((l) => ({ level: l, reason: `test rule: ${l}` })) };
  },
};

const turn = (...calls: ToolCall[]): GenerateResult => ({
  message: { role: 'assistant', content: '', toolCalls: calls },
  finishReason: 'tool_calls',
});
const answer: GenerateResult = {
  message: { role: 'assistant', content: 'done', toolCalls: [] },
  finishReason: 'stop',
};
const lookup: ToolCall = { id: 'c1', name: 'orders_get', arguments: '{"number":"ORD-7"}' };
const refund: ToolCall = {
  id: 'c2',
  name: 'refunds_request',
  arguments: '{"orderId":"ORD-7","amountCents":32893}',
};

/** A durable run where the model asks for a lookup and a refund in one turn, then answers. */
function setup(script: GenerateResult[] = [turn(lookup, refund), answer]) {
  const read = countingTool('orders_get', 'read');
  const write = countingTool('refunds_request', 'write');
  const registry = new ToolRegistry([read.tool, write.tool]);
  const llm = new FakeProvider(script);
  const checkpointer = new MemorySaver();
  const deps = {
    llm,
    registry,
    executor: new ToolExecutor(registry),
    approvals,
    checkpointer,
    runId: 'run-1',
    access: {
      principal: { userId: 'u1', role: 'support' },
      authorizer: { authorize: () => ({ allowed: true }) as const },
    },
  };
  const start = () =>
    startAgentRun({ ...deps, messages: [{ role: 'user', content: 'refund ORD-7' }] });
  return { deps, start, read, write, llm, checkpointer };
}

describe('approval gate (durable runs)', () => {
  it('pauses before any call of the turn runs, with every call and its exact arguments', async () => {
    const { start, read, write } = setup();
    const outcome = await start();

    expect(outcome.status).toBe('waiting_for_approval');
    if (outcome.status !== 'waiting_for_approval') return;
    expect(outcome.request).toEqual({
      level: 'high',
      requesterId: 'u1',
      calls: [
        { ...lookup, level: 'none', reason: 'test rule: none' },
        { ...refund, level: 'high', reason: 'test rule: high' },
      ],
    });
    expect(write.runs()).toBe(0);
    expect(read.runs()).toBe(0); // all or nothing: the read waits with the write
  });

  it('approving runs each call exactly once; resuming again never runs the write again', async () => {
    const { deps, start, read, write, checkpointer } = setup();
    await start();

    const done = await resumeAgentRun({
      ...deps,
      decision: { decision: 'approved', approverId: 'u2' },
    });
    expect(done.status).toBe('finished');
    expect(write.runs()).toBe(1);
    expect(read.runs()).toBe(1);

    // Our guard: a finished run is not waiting, so a second resume is refused.
    await expect(
      resumeAgentRun({ ...deps, decision: { decision: 'approved', approverId: 'u2' } }),
    ).rejects.toThrow(/not waiting for approval/);
    // The framework itself: a fresh graph on the same saver, resuming the finished thread
    // directly, does not run the write again either.
    const fresh = buildAgentGraph(checkpointer);
    await fresh.invoke(new Command({ resume: { decision: 'approved', approverId: 'u2' } }), {
      configurable: { thread_id: 'run-1' },
      context: {
        llm: deps.llm,
        registry: deps.registry,
        executor: deps.executor,
        selector: undefined,
        limits: { maxIterations: 8, maxConsecutiveToolErrors: 3 },
        access: deps.access,
        approvals,
      },
    });
    expect(write.runs()).toBe(1);
  });

  it('rejecting runs nothing and tells the model why', async () => {
    const { deps, start, read, write, llm } = setup();
    await start();

    const done = await resumeAgentRun({
      ...deps,
      decision: { decision: 'rejected', approverId: 'u2', reason: 'amount too high' },
    });
    expect(done).toMatchObject({ status: 'finished', result: { answer: 'done' } });
    expect(write.runs()).toBe(0);
    expect(read.runs()).toBe(0);
    // The model's next call saw one "not run" result per call of the rejected turn.
    const tools = llm.requests.at(-1)?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(tools.map((m) => m.content)).toEqual([
      'Not run: rejected by u2: amount too high',
      'Not run: rejected by u2: amount too high',
    ]);
  });

  it('refuses self-approval of a high-risk turn (defense in depth inside the graph)', async () => {
    const { deps, start, write } = setup();
    await start();
    await resumeAgentRun({ ...deps, decision: { decision: 'approved', approverId: 'u1' } });
    expect(write.runs()).toBe(0);
  });

  it('lets the requester approve a turn whose strictest level is only "required"', async () => {
    const notes: ToolCall = { id: 'c3', name: 'orders_update_notes', arguments: '{}' };
    const { deps, write } = setup();
    const updateNotes = countingTool('orders_update_notes', 'write');
    const registry = new ToolRegistry([write.tool, updateNotes.tool]);
    const run = {
      ...deps,
      registry,
      executor: new ToolExecutor(registry),
      llm: new FakeProvider([turn(notes), answer]),
    };
    const outcome = await startAgentRun({ ...run, messages: [{ role: 'user', content: 'note' }] });
    expect(outcome).toMatchObject({
      status: 'waiting_for_approval',
      request: { level: 'required' },
    });
    await resumeAgentRun({ ...run, decision: { decision: 'approved', approverId: 'u1' } });
    expect(updateNotes.runs()).toBe(1);
  });

  it('treats a malformed answer as a rejection', async () => {
    const { deps, start, write } = setup();
    await start();
    await resumeAgentRun({
      ...deps,
      decision: { decision: 'yes please', approverId: '' } as never,
    });
    expect(write.runs()).toBe(0);
  });

  it('does not pause when the turn has only reads', async () => {
    const { start, read } = setup([turn(lookup), answer]);
    expect(await start()).toMatchObject({ status: 'finished', result: { answer: 'done' } });
    expect(read.runs()).toBe(1);
  });

  it('does not ask for approval of a call to a tool that was not offered; it is refused', async () => {
    const { deps, write } = setup();
    // The role may not use refunds, so the menu lacks it, but the model asks for one anyway.
    const access = {
      principal: { userId: 'u1', role: 'warehouse' },
      authorizer: {
        authorize: (_p: unknown, name: string) =>
          name === 'refunds_request'
            ? ({ allowed: false, reason: 'not for warehouse' } as const)
            : ({ allowed: true } as const),
      },
    };
    const outcome = await startAgentRun({
      ...deps,
      access,
      llm: new FakeProvider([turn(refund), answer]),
      messages: [{ role: 'user', content: 'refund ORD-7' }],
    });
    expect(outcome).toMatchObject({ status: 'finished', result: { answer: 'done' } });
    expect(write.runs()).toBe(0);
  });

  it('engines that cannot pause refuse approval rules instead of ignoring them', async () => {
    const { deps, write } = setup();
    const input = { ...deps, messages: [{ role: 'user' as const, content: 'refund' }] };
    await expect(runAgent(input)).rejects.toThrow(/raw loop does not support approvals/);
    await expect(runAgentGraph(input)).rejects.toThrow(/need a durable run/);
    expect(write.runs()).toBe(0);
  });
});
