/**
 * Policy search in agent runs (ADR 0054), through the HTTP API and a worker, on real MongoDB with
 * its vector search. REQUIRED tests (BUILD_PLAN section 4):
 * - tenant isolation: a run only ever reads the documents of its own tenant and its own API;
 * - RBAC: a role without the permission is not offered the search, and a forced call is refused;
 * - approvals: trusted policy text alone does not change who must approve a write, while data from
 *   the API still does.
 * Also: no documents means no tool, a broken search tells the model nothing internal, and the
 * sources an answer names are checked.
 *
 * A scripted model stands in for the LLM and a fake server for the embedding model: each word of a
 * text counts in one place of its vector, so texts with the same words are near each other.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FakeProvider,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type StreamEvent,
} from '@toolbridge/agent-core';
import { chunkMarkdown, connectKnowledgeIndex, type KnowledgeIndex } from '@toolbridge/retrieval';
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

const TOKEN = 'knowledge-e2e-token';
const ORDER_ID = 'a'.repeat(24);

/** What the model does in a test: these calls one by one, then this answer. */
interface Script {
  calls: [tool: string, args: Record<string, unknown>][];
  /** Default: what the last tool returned, so a test sees exactly what the model saw. */
  answer?: string;
}

/** Plays the script in the user's message. */
class ScriptModel implements LLMProvider {
  /** The tool names offered on the latest first call of a run. */
  offered: string[] = [];
  /** The system prompt of the latest call. */
  system = '';
  private ids = 0;

  generate(input: GenerateRequest): Promise<GenerateResult> {
    const { messages } = input;
    this.system = messages[0]?.content ?? '';
    const start = messages.findLastIndex((m) => m.role === 'user');
    const script = JSON.parse(messages[start]?.content ?? '{}') as Script;
    const results = messages.slice(start).filter((m) => m.role === 'tool');
    if (results.length === 0) this.offered = (input.tools ?? []).map((t) => t.name);
    const next = script.calls[results.length];
    return Promise.resolve({
      message: {
        role: 'assistant',
        content: next ? '' : (script.answer ?? `final: ${results.at(-1)?.content ?? ''}`),
        toolCalls: next
          ? [
              {
                id: `call-${String(++this.ids)}`,
                name: next[0],
                arguments: JSON.stringify(next[1]),
              },
            ]
          : [],
      },
      finishReason: next ? 'tool_calls' : 'stop',
    });
  }

  /** The same answer as a stream. */
  async *stream(input: GenerateRequest): AsyncIterable<StreamEvent> {
    yield* new FakeProvider([await this.generate(input)]).stream(input);
  }
}

/** One vector: how often each word occurs, by a small hash, scaled to length one. */
function vectorOf(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 0.01; // never all zeros
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
    const place = 1 + (hash % (dimensions - 1));
    vector[place] = (vector[place] ?? 0) + 1;
  }
  const length = Math.hypot(...vector);
  return vector.map((v) => v / length);
}

let h: Harness;
let model: ScriptModel;
let index: { index: KnowledgeIndex; close: () => Promise<void> };
let embedder: Server;
let upstream: Server;
let upstreamUrl: string;
/** Order notes written to the fake API. */
let notesWritten = 0;
/** Makes the embedding server fail, with a text that must not reach the model. */
let embedderDown = false;

/** Starts a server on a free port and returns it with its port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve();
    }),
  );
  return (server.address() as AddressInfo).port;
}

const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  put: (path: string) => request(h.http).put(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${key}`),
});

/** Adds an API with the host spec and policy to a tenant; returns the spec's id. */
async function addSpec(key: string, name: string): Promise<string> {
  const created = await as(key)
    .post('/specs')
    .send({ name, document: hostSpec(), overrides: hostOverrides() })
    .expect(201);
  const specId = body<{ spec: { id: string } }>(created).spec.id;
  await as(key)
    .put(`/specs/${specId}/connection`)
    .send({ baseUrl: upstreamUrl, authKind: 'static', secrets: { bearer: TOKEN } })
    .expect(200);
  await as(key)
    .patch(`/specs/${specId}/tools/orders_update_notes`)
    .send({ enabled: true })
    .expect(200);
  await as(key).put(`/specs/${specId}/policy`).send({ policy: hostPolicy() }).expect(200);
  return specId;
}

/** Loads one document for an API of a tenant, as the operator command does. */
async function load(
  tenantId: string,
  specId: string,
  text: string,
  docId = 'refund-policy',
): Promise<void> {
  const scope = { tenantId, source: specId };
  const chunks = chunkMarkdown(docId, `# Refund policy\n\n## Refund window\n\n${text}`);
  await index.index.reindex(scope, chunks);
  const last = chunks.at(-1);
  if (last) await index.index.waitUntilSearchable(scope, last);
}

interface RunView {
  status: string;
  answer: string | null;
  error: string | null;
}
interface Finished {
  answer?: string;
  sources?: { id: string; section: string }[];
  sourceWarning?: string;
}

/** Runs a script as a person and waits until the run ends or pauses. */
async function run(
  key: string,
  specId: string,
  script: Script,
  role = 'support',
): Promise<RunView & { finished: Finished | undefined }> {
  const token = await mintSession(h.http, key, specId, 'u1', role);
  const started = await as(token)
    .post('/runs')
    .send({ message: JSON.stringify(script) })
    .expect(202);
  const { runId } = body<{ runId: string }>(started);
  for (let i = 0; i < 200; i++) {
    const view = body<RunView>(await as(token).get(`/runs/${runId}`).expect(200));
    if (view.status === 'failed') throw new Error(view.error ?? 'failed');
    if (view.status === 'waiting_for_approval') return { ...view, finished: undefined };
    if (view.status === 'completed') {
      const stream = await as(token).get(`/runs/${runId}/events`).buffer(true);
      const last = stream.text.split('\n').findLast((line) => line.startsWith('data:')) ?? '';
      const event = JSON.parse(last.slice(5)) as { data: Finished };
      return { ...view, finished: event.data };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the run never ended');
}

const search = (query = 'refund window'): Script['calls'][number] => [
  'knowledge_search',
  { query },
];

let alice: { id: string; key: string; specId: string; otherSpecId: string; emptySpecId: string };
let bob: { id: string; key: string; specId: string };

beforeAll(async () => {
  embedder = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      if (embedderDown) {
        res.writeHead(500).end('SECRET-INTERNAL-HOST');
        return;
      }
      const { input, dimensions } = JSON.parse(raw) as { input: string[]; dimensions: number };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ embeddings: input.map((text) => vectorOf(text, dimensions)) }));
    });
  });
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'PATCH') notesWritten++;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ _id: ORDER_ID, number: 'ORD-7', status: 'paid', notes: '' }));
    });
  });
  const embedderUrl = `http://127.0.0.1:${String(await listen(embedder))}`;
  upstreamUrl = `http://localhost:${String(await listen(upstream))}`;
  model = new ScriptModel();
  h = await startHarness(
    { EMBEDDING_BASE_URL: embedderUrl, PLATFORM_ALLOW_PRIVATE_HOSTS: 'localhost,127.0.0.1' },
    { llm: model },
  );
  index = await connectKnowledgeIndex({
    mongoUri: h.config.MONGO_URI,
    dbName: h.config.PLATFORM_MONGO_DB,
    embedding: h.config.embedding,
  });

  const a = await createTenant(h.http, 'Alice');
  alice = {
    ...a,
    specId: await addSpec(a.key, 'store'),
    otherSpecId: await addSpec(a.key, 'second'),
    emptySpecId: await addSpec(a.key, 'empty'),
  };
  const b = await createTenant(h.http, 'Bob');
  bob = { ...b, specId: await addSpec(b.key, 'store') };
  // The same words everywhere, so only the scope can tell the documents apart.
  await load(alice.id, alice.specId, 'The refund window is ALICE-MAIN days.');
  await load(alice.id, alice.otherSpecId, 'The refund window is ALICE-SECOND days.');
  await load(bob.id, bob.specId, 'The refund window is BOB days.');
  // Bob's document under ALICE's spec id: spec ids are unique, so only this shows that the tenant
  // itself is part of the filter. Its own document id, so the wait really waits for this one.
  await load(bob.id, alice.specId, 'The refund window is WRONG-TENANT days.', 'stray-policy');
}, 180_000);

afterAll(async () => {
  await index.close();
  await h.stop();
  embedder.closeAllConnections();
  embedder.close();
  upstream.closeAllConnections();
  upstream.close();
});

describe('policy search in runs', () => {
  it('isolation: a run reads only the documents of its own tenant and its own API', async () => {
    const cases = [
      [alice.key, alice.specId, 'ALICE-MAIN'],
      [alice.key, alice.otherSpecId, 'ALICE-SECOND'],
      [bob.key, bob.specId, 'BOB'],
    ] as const;
    for (const [key, specId, own] of cases) {
      const { answer } = await run(key, specId, { calls: [search()] });
      expect(answer).toContain(own);
      for (const [, , other] of cases) if (other !== own) expect(answer).not.toContain(other);
      expect(answer).not.toContain('WRONG-TENANT');
    }
  });

  it('isolation: the model cannot choose another scope', async () => {
    const { answer } = await run(bob.key, bob.specId, {
      calls: [
        [
          'knowledge_search',
          { query: 'refund window', tenantId: alice.id, source: alice.specId, spec: alice.specId },
        ],
      ],
    });
    expect(answer).toContain('BOB');
    expect(answer).not.toContain('ALICE');
  });

  it('is not offered without documents, and then a forced call is refused', async () => {
    const { answer } = await run(alice.key, alice.emptySpecId, { calls: [search()] });
    expect(model.offered.length).toBeGreaterThan(0);
    expect(model.offered).not.toContain('knowledge_search');
    expect(model.system).not.toContain('knowledge_search');
    expect(answer).toContain('not available');
  });

  it('RBAC: a role the policy does not allow is not offered it, and a forced call is refused', async () => {
    const policy = hostPolicy() as { roles: Record<string, { allow: string[] }> };
    const warehouse = policy.roles.warehouse;
    if (!warehouse) throw new Error('no warehouse role');
    warehouse.allow = warehouse.allow.filter((name) => name !== 'knowledge_search');
    await as(alice.key).put(`/specs/${alice.otherSpecId}/policy`).send({ policy }).expect(200);

    const refused = await run(alice.key, alice.otherSpecId, { calls: [search()] }, 'warehouse');
    expect(model.offered).not.toContain('knowledge_search');
    expect(refused.answer).toContain('not available');
    expect(refused.answer).not.toContain('ALICE');
    expect(model.system).not.toContain('knowledge_search');
    // The same question from a role that may: offered and answered, with the prompt rules.
    const allowed = await run(alice.key, alice.otherSpecId, { calls: [search()] });
    expect(model.offered).toContain('knowledge_search');
    expect(model.system).toContain('knowledge_search');
    expect(allowed.answer).toContain('ALICE-SECOND');
  });

  it('approvals: policy text alone changes nothing; data from the API still needs a person', async () => {
    const note: Script['calls'][number] = ['orders_update_notes', { id: ORDER_ID, notes: 'x' }];
    const before = notesWritten;
    // The host policy says orders_update_notes needs no approval when nothing was read.
    const afterSearch = await run(alice.key, alice.specId, { calls: [search(), note] });
    expect(afterSearch.status).toBe('completed');
    expect(notesWritten - before).toBe(1);

    const afterRead = await run(alice.key, alice.specId, {
      calls: [search(), ['orders_get', { number: 'ORD-7' }], note],
    });
    expect(afterRead.status).toBe('waiting_for_approval');
    expect(notesWritten - before).toBe(1);
  });

  it('a broken search tells the model nothing internal, and the run goes on', async () => {
    embedderDown = true;
    try {
      const { status, answer } = await run(alice.key, alice.specId, { calls: [search()] });
      expect(status).toBe('completed');
      expect(answer).toContain('unavailable right now');
      expect(answer).not.toContain('SECRET');
      expect(answer).not.toContain('127.0.0.1');
    } finally {
      embedderDown = false;
    }
  });

  it('names only sources that were really retrieved, and warns about the others', async () => {
    const id = 'refund-policy#refund-window';
    const good = await run(alice.key, alice.specId, {
      calls: [search()],
      answer: `Yes [${id}].`,
    });
    expect(good.finished?.sources).toEqual([{ id, section: 'Refund policy > Refund window' }]);
    expect(good.finished?.sourceWarning).toBeUndefined();

    const invented = await run(alice.key, alice.specId, {
      calls: [search()],
      answer: 'Yes [refund-policy#made-up].',
    });
    expect(invented.finished?.sources).toEqual([]);
    expect(invented.finished?.sourceWarning).toContain('refund-policy#made-up');

    const notSearched = await run(alice.key, alice.specId, { calls: [], answer: `Yes [${id}].` });
    expect(notSearched.finished?.sources).toEqual([]);
    expect(notSearched.finished?.sourceWarning).toContain(id);

    const plain = await run(alice.key, alice.specId, { calls: [], answer: 'Hello.' });
    expect(plain.finished?.sources).toBeUndefined();
    expect(plain.finished?.sourceWarning).toBeUndefined();
  });
});
