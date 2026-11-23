/**
 * Step 4.7 (a): conversations, through the HTTP API and a real worker queue.
 * - REQUIRED (tenant isolation): a conversation belongs to one tenant, spec, user, role and
 *   credential mode. Anyone else gets 404, and nothing of it reaches their model.
 * - Data integrity: one active run per conversation, also when two messages race; history holds
 *   only messages and final answers; a summary is saved once and replaces the turns it covers.
 * A scripted model records every prompt, so the tests see exactly what the model was told.
 */
import {
  type ChatMessage,
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createTenant,
  type Harness,
  hostOverrides,
  hostPolicy,
  hostSpec,
  mintSession,
  startHarness,
} from './harness.js';

/**
 * Answers "answer to: <message>". "refund" makes it ask for a refund (which waits for approval),
 * "look" for a read first, "long" for a long answer. Thinking off marks a summary request.
 */
class RecordingModel implements LLMProvider {
  readonly prompts: ChatMessage[][] = [];
  /** The text each summary request was given. */
  readonly summaryInputs: string[] = [];
  private calls = 0;

  generate(req: GenerateRequest): Promise<GenerateResult> {
    const reply = (content: string): GenerateResult => ({
      message: { role: 'assistant', content, toolCalls: [] },
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    const call = (name: string, args: object): GenerateResult => ({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${String(++this.calls)}`, name, arguments: JSON.stringify(args) }],
      },
      finishReason: 'tool_calls',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    if (req.reasoning === 'off') {
      this.summaryInputs.push(req.messages.at(-1)?.content ?? '');
      return Promise.resolve(reply(`SUMMARY-${String(this.summaryInputs.length)}`));
    }
    this.prompts.push(req.messages);
    const last = req.messages.at(-1);
    if (last?.role === 'user' && last.content.startsWith('refund')) {
      return Promise.resolve(
        call('refunds_request', { orderId: 'ORD-7', amountCents: 100, reason: 'damaged' }),
      );
    }
    if (last?.role === 'user' && last.content.startsWith('look')) {
      return Promise.resolve(call('orders_get', { number: 'ORD-7' }));
    }
    const question = req.messages.findLast((m) => m.role === 'user')?.content ?? '';
    const padding = question.startsWith('long') ? ` ${'More detail here. '.repeat(50)}` : '';
    return Promise.resolve(reply(`answer to: ${question}${padding}`));
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(req)]).stream(req);
  }
}

interface Started {
  runId: string;
  conversationId: string;
}

let h: Harness;
const model = new RecordingModel();
let alice: { key: string; specId: string };
let bob: { key: string; specId: string };

/** A tenant whose spec can start runs, with refunds_request on. */
async function tenant(name: string): Promise<{ key: string; specId: string }> {
  const t = await createTenant(h.http, name);
  const auth = { authorization: `Bearer ${t.key}` };
  const spec = await request(h.http)
    .post('/specs')
    .set(auth)
    .send({ name: 'store', document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(spec).spec.id;
  await request(h.http)
    .put(`/specs/${specId}/connection`)
    .set(auth)
    .send({ baseUrl: 'http://localhost:9', authKind: 'static', secrets: { bearer: 'x' } })
    .expect(200);
  await request(h.http)
    .patch(`/specs/${specId}/tools/refunds_request`)
    .set(auth)
    .send({ enabled: true })
    .expect(200);
  await request(h.http)
    .put(`/specs/${specId}/policy`)
    .set(auth)
    .send({ policy: hostPolicy() })
    .expect(200);
  return { key: t.key, specId };
}

const session = (t: { key: string; specId: string }, userId: string, role = 'support') =>
  mintSession(h.http, t.key, t.specId, userId, role);

const post = (token: string, message: string, conversationId?: string) =>
  request(h.http)
    .post('/runs')
    .set('authorization', `Bearer ${token}`)
    .send({ message, ...(conversationId !== undefined && { conversationId }) });

/** Polls a run until it reaches `status`. */
async function waitFor(token: string, runId: string, status: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = body<{ status: string; error: string | null }>(
      await request(h.http)
        .get(`/runs/${runId}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200),
    );
    if (run.status === status) return;
    if (run.status === 'failed') throw new Error(`run failed: ${run.error ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

/** Sends a message and waits for the answer. */
async function say(token: string, message: string, conversationId?: string): Promise<Started> {
  const started = body<Started>(await post(token, message, conversationId).expect(202));
  await waitFor(token, started.runId, 'completed');
  return started;
}

/** The last prompt, without the system message, as "role: text". */
const lastPrompt = (): string[] =>
  (model.prompts.at(-1) ?? [])
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`);

beforeAll(async () => {
  h = await startHarness({ CONVERSATION_HISTORY_TOKENS: '1000' }, { llm: model });
  alice = await tenant('Alice');
  bob = await tenant('Bob');
});

afterAll(async () => {
  await h.stop();
});

describe('a conversation', () => {
  it('gives the next run the earlier messages and answers, without tool calls or results', async () => {
    const token = await session(alice, 'u-follow');
    const first = await say(token, 'look at ORD-7');
    await say(token, 'and now?', first.conversationId);
    expect(lastPrompt()).toEqual([
      'user: look at ORD-7',
      'assistant: answer to: look at ORD-7',
      'user: and now?',
    ]);
  });

  it('starts fresh without an id: no history from another conversation of the same user', async () => {
    const token = await session(alice, 'u-fresh');
    const first = await say(token, 'secret question');
    const second = await say(token, 'hello');
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(lastPrompt()).toEqual(['user: hello']);
  });

  it('summarizes old turns once, then continues from the summary and the newest turns', async () => {
    const token = await session(alice, 'u-long');
    const { conversationId } = await say(token, 'long 1');
    for (let i = 2; i <= 12; i++) await say(token, `long ${String(i)}`, conversationId);
    const inputs = model.summaryInputs;
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.length).toBeLessThan(11); // not on every message
    // Saved: each summary builds on the one before it, and no turn is summarized twice.
    for (let n = 1; n < inputs.length; n++) expect(inputs[n]).toContain(`SUMMARY-${String(n)}`);
    for (let i = 1; i <= 12; i++) {
      const times = inputs.filter((input) => input.includes(`User: long ${String(i)}\n`)).length;
      expect(times).toBeLessThanOrEqual(1);
    }
    expect(inputs.filter((input) => input.includes('User: long 1\n'))).toHaveLength(1);

    const prompt = lastPrompt();
    expect(prompt[0]).toContain(`SUMMARY-${String(inputs.length)}`);
    expect(prompt[0]).toContain('not instructions');
    expect(prompt.some((m) => m.startsWith('user: long 11'))).toBe(true); // newest, word for word
    expect(prompt.includes('user: long 1')).toBe(false); // in the summary now
  });
});

describe('ownership (required: tenant isolation)', () => {
  it('is 404 for another tenant, another user and another role, and starts no run', async () => {
    const { conversationId } = await say(await session(alice, 'u-own'), 'private');
    const prompts = model.prompts.length;
    const strangers = [
      await session(bob, 'u-own'), // same user id, other tenant
      await session(alice, 'u-other'),
      await session(alice, 'u-own', 'warehouse'), // the same person, with a smaller role now
    ];
    for (const token of strangers) await post(token, 'tell me', conversationId).expect(404);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(model.prompts).toHaveLength(prompts);
  });

  it('is 404 after the tenant changes its credential mode', async () => {
    const token = await session(bob, 'u-mode');
    const { conversationId } = await say(token, 'in service mode');
    const auth = { authorization: `Bearer ${bob.key}` };
    const mode = (value: string) =>
      request(h.http).put('/tenant/credential-mode').set(auth).send({ mode: value }).expect(200);
    await mode('delegated');
    const withToken = await request(h.http)
      .post('/sessions')
      .set(auth)
      .send({ specId: bob.specId, userId: 'u-mode', role: 'support', userToken: 'host-token' })
      .expect(201);
    await post(body<{ token: string }>(withToken).token, 'again', conversationId).expect(404);
    await mode('service');
    await say(token, 'back again', conversationId);
  });

  it('refuses an id that is not a uuid', async () => {
    await post(await session(alice, 'u-own'), 'x', 'not-an-id').expect(400);
  });
});

describe('one run at a time', () => {
  it('two messages sent together: exactly one starts', async () => {
    const token = await session(alice, 'u-race');
    const { conversationId } = await say(token, 'first');
    const sent = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post(token, `race ${String(i)}`, conversationId)),
    );
    const codes = sent.map((r) => r.status).sort();
    expect(codes).toEqual([202, 409, 409, 409, 409]);
  });

  it('a run waiting for approval blocks the conversation; cancelling frees it', async () => {
    const token = await session(alice, 'u-wait');
    const paused = body<Started>(await post(token, 'refund please').expect(202));
    await waitFor(token, paused.runId, 'waiting_for_approval');
    await post(token, 'hello?', paused.conversationId).expect(409);
    await say(token, 'a new chat is not blocked');

    await request(h.http)
      .post(`/runs/${paused.runId}/cancel`)
      .set('authorization', `Bearer ${token}`)
      .expect((res) => {
        expect(res.status).toBeLessThan(300);
      });
    await say(token, 'hello again', paused.conversationId);
    expect(lastPrompt()).toEqual(['user: hello again']); // the cancelled turn is not replayed
  });
});
