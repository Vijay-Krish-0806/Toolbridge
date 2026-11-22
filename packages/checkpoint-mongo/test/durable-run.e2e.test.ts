/**
 * REQUIRED test (approvals), on the real MongoDB checkpointer: a run paused for approval survives
 * a restart (the first client is closed; a new client and saver open the same database, as a new
 * process would), the write runs only after approval, exactly once, and a second resume after
 * the restart does not run it again.
 */
import { randomUUID } from 'node:crypto';

import {
  FakeProvider,
  ToolExecutor,
  ToolRegistry,
  defineTool,
  resumeAgentRun,
  startAgentRun,
  type ApprovalPolicy,
  type GenerateResult,
} from '@toolbridge/agent-core';
import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MongoSaver } from '../src/mongo-saver.js';

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set (copy .env.example to .env).');
const dbName = `durable_run_${randomUUID().slice(0, 8)}`;
const clients: MongoClient[] = [];

/** Opens a new client and saver on the test database: a fresh "process". */
async function openSaver(): Promise<{ client: MongoClient; saver: MongoSaver }> {
  const client = await new MongoClient(uri ?? '').connect();
  clients.push(client);
  const saver = new MongoSaver({ db: client.db(dbName) });
  await saver.setup();
  return { client, saver };
}

/** Closes every client the test opened, then drops the test database. */
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  const cleanup = await new MongoClient(uri).connect();
  await cleanup.db(dbName).dropDatabase();
  await cleanup.close();
});

describe('durable run on MongoSaver', () => {
  it('pauses, survives a restart, runs the write once after approval, never twice', async () => {
    let refunds = 0;
    const refundTool = defineTool({
      name: 'refunds_request',
      description: 'refund',
      safety: 'write',
      input: z.looseObject({}),
      execute: () => {
        refunds++;
        return Promise.resolve({ ok: true });
      },
    });
    const registry = new ToolRegistry([refundTool]);
    const approvals: ApprovalPolicy = {
      evaluate: (calls) => ({
        level: 'high',
        calls: calls.map(() => ({ level: 'high' as const, reason: 'test: refunds are high risk' })),
      }),
    };
    const refundTurn: GenerateResult = {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'refunds_request', arguments: '{"amountCents":32893}' }],
      },
      finishReason: 'tool_calls',
    };
    const answer: GenerateResult = {
      message: { role: 'assistant', content: 'refund filed', toolCalls: [] },
      finishReason: 'stop',
    };
    const runId = randomUUID();
    const deps = {
      runId,
      registry,
      executor: new ToolExecutor(registry),
      approvals,
      access: {
        principal: { userId: 'u1', role: 'support' },
        authorizer: { authorize: () => ({ allowed: true }) as const },
      },
    };

    // Process 1: start the run; it pauses on the approval card. Then the process "dies".
    const first = await openSaver();
    const paused = await startAgentRun({
      ...deps,
      checkpointer: first.saver,
      llm: new FakeProvider([refundTurn]),
      messages: [{ role: 'user', content: 'refund ORD-7 in full' }],
    });
    expect(paused.status).toBe('waiting_for_approval');
    expect(refunds).toBe(0);
    await first.client.close();

    // Process 2: a new client and saver on the same database; the approver approves.
    const second = await openSaver();
    const done = await resumeAgentRun({
      ...deps,
      checkpointer: second.saver,
      llm: new FakeProvider([answer]),
      decision: { decision: 'approved', approverId: 'u2' },
    });
    expect(done).toMatchObject({ status: 'finished', result: { answer: 'refund filed' } });
    expect(refunds).toBe(1);

    // Process 3: another restart, and a second approval for the same run: refused, no new write.
    const third = await openSaver();
    await expect(
      resumeAgentRun({
        ...deps,
        checkpointer: third.saver,
        llm: new FakeProvider([answer]),
        decision: { decision: 'approved', approverId: 'u2' },
      }),
    ).rejects.toThrow(/not waiting for approval/);
    expect(refunds).toBe(1);
  });
});
