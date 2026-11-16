# ToolBridge: Build Plan for Claude Code

Prepared for Vijay. This is the step-by-step build spec to hand to Claude Code. It pairs with the 14-week roadmap: the roadmap says when, this says exactly what, in what order, and why.

## 0. How to use this plan

1. Create the repo, save this file as `docs/BUILD_PLAN.md`, and copy section 4 into `CLAUDE.md` at the repo root.
2. Work on **one step at a time**. Start each session with the prompt template in section 7.
3. After each step: run the acceptance checks, ask Claude Code to explain what it built and why (the Learn line), commit, then write a learning note into the shared learning inbox (section 1.2), and add one line to `docs/learning-log.md`.
4. Never request two steps at once. If a step feels too big, split it.
5. Every architectural decision gets a short ADR in `docs/adr/` (context, decision, alternatives rejected, consequences). These become your interview notes.
6. At the end of each phase, ask Claude Code for a 5-minute architecture walkthrough, a 10-question quiz, and what would break at 100x scale.

## 1. Project brief

**ToolBridge** compiles any OpenAPI (Swagger) spec into agent-ready tools, exposes them as an MCP server, and runs a permission-aware agent over them. Each API operation becomes one tool. The platform adds tool retrieval, role-based access, human approval for risky writes, durable background runs, evals, and tracing.

**Host app:** a purpose-built e-commerce store-operations API used to prove it works. ToolBridge only ever sees the OpenAPI spec, never host-app code.

**Non-goals:** a general chatbot, a fine-tuned model, or a replacement for the host app's own UI.

## 1.1 Minimum path and cost guard

**v1 (a working demo, build this first):** Steps 0.1 to 0.3, 1.1 to 1.3, 2.1 to 2.3, 2.5, 4.2 to 4.5, 5.1 and 5.2, plus UI screens U1 and U3. Everything else is v2.

**If you fall behind, cut in this order:** 6.3, 7.4, U4, 4.7, 4.8, 3.4, 4.6. Never cut 4.2 (RBAC), 4.3 (approvals), 4.5 (idempotency), 4.9 (injection defense), or Phase 5 (evals).

**Cost guard:** local-only, no API keys and no paid services. Every model runs on your laptop through Ollama, reached through an OpenAI-compatible adapter. Read the provider, base URL, and model name from environment variables. Tests use the fake provider, so they need no model at all. Never commit keys. If you ever add a hosted provider later, it plugs in behind the same `LLMProvider` port, and you set a spend cap first.

**Local model choice (checked 2026-11-16 on ollama.com, re-check when you start Step 1.1):**

| Role | Model (Ollama tag) | Download | Why |
| --- | --- | --- | --- |
| Default chat and tools | `qwen3.5:4b` | 3.3 to 4.0 GB | Tagged tools and thinking, 256K max context. The 4B size is the largest that sits mostly on a 4 GB GPU. |
| Stronger, slower comparison | `qwen3.5:9b` | 6.6 to 7.6 GB | Same family, so the comparison is fair. It spills into system RAM, so use it for eval comparisons, not daily development. |
| Fallback if Qwen3.5 misbehaves | `qwen3:4b` | 2.5 GB | The previous generation, smaller and widely used for local tool calling. |
| Embeddings | `qwen3-embedding:0.6b` | 639 MB | 32K context, so a whole tool description fits. Output dimensions are configurable from 32 up. |

**Why not Kimi or DeepSeek:** they are excellent open-weight models but far too large for this laptop. Kimi K2 has 1 trillion parameters (and was retired from Ollama's library in June 2026), and DeepSeek V3.1 is a 404 GB download. Ollama's cloud does host newer Kimi and DeepSeek versions, but its $0 plan is pay per token, so it is not free. Small Qwen models are the practical open choice at this hardware size.

**Context window (important):** on machines with less than 24 GiB VRAM, Ollama defaults to only 4K tokens of context and silently drops anything older. Tool definitions plus results overflow that quickly. The OpenAI-compatible endpoint cannot set context size per request, so set it on the server (`OLLAMA_CONTEXT_LENGTH`) or bake `num_ctx` into a Modelfile. Ollama recommends at least 64K for agents. On a 4 GB GPU, a bigger context costs memory and speed, so start at 16K to 32K and measure in Step 1.4.

**Other local limits to design around:** the OpenAI-compatible endpoint does not support `tool_choice`, so you cannot force a tool call; the loop must handle a plain text answer at any step. Small models make more malformed tool calls than frontier models, so validate every call with Zod, return the error to the model, and cap retries. Tight tool descriptions and Phase 3 tool retrieval matter even more here. Keep Docker services lean (start n8n and Langfuse only when their phase begins), because MongoDB, Redis, the model, and your editor all share 16 GB.

**Pace:** with Claude Code writing the code, aim for one phase every 1 to 2 weeks. Your review and learning time is the bottleneck, not typing.

## 1.2 Workspace and learning inbox

**Location:** this project lives in `/learning/toolbridge`, next to the learning app and NotifyX. The shared learning inbox is `/learning/learning-inbox/`, outside this repo and never committed to it. Give Claude Code access to that folder (for example with /add-dir), or start it from `/learning`.

**Rule:** building and learning stay separate. During a build session, Claude Code only writes one short note into the inbox at the end of each step. The actual studying happens in the learning app, which ingests the inbox.

**Note format:** one file per step, named `toolbridge-step-<id>-<topic-slug>.md`, under about 400 words, so it adds minutes and not hours. Write one extra summary note at the end of each phase.

```markdown
---
source: toolbridge
step: 2.2
topic: Tool schema design for LLMs
tags: [agents, mcp, openapi]
date: YYYY-MM-DD
---
## What we built and why
## Core concepts (fundamentals to production-grade)
## Alternatives and trade-offs
## Interview scenarios (what will you do if...)
## Good articles (official engineering blogs or docs)
```

Only include article links that Claude Code has actually opened. No guessed URLs. The Learn line of each step is the seed for the note's topic.

## 2. Tech stack, and why

| Layer | Choice | Why | Alternatives |
| --- | --- | --- | --- |
| Language | TypeScript (strict) end to end | Your stack. One language lets types be shared across spec compiler, API, workers, and UI. Official MCP and LangGraph SDKs exist for it. | Python: the AI ecosystem is deeper, and LangGraph Python is generally more mature. A good choice if you later want to go ML-heavy. Using Python only for the eval runner is a reasonable hybrid. |
| Monorepo | pnpm workspaces and Turborepo | Fast installs, clear package boundaries, cached builds. | Nx |
| API and workers | NestJS | Modules and dependency injection enforce structure, and Swagger support is built in. You know it. | Fastify or Hono (lighter, less structure) |
| Database | MongoDB with Atlas Vector Search | You know it, and it keeps documents and vectors in one store. | PostgreSQL with pgvector: better transactions and relational integrity, and arguably the stronger production default. Worth a comparison ADR. |
| Queue and cache | Redis with BullMQ | Simple, proven job queues with retries and delayed jobs. Redis also covers caching and rate limits. | Temporal (most robust durable execution, heavy), Inngest, Trigger.dev |
| Agent orchestration | LangGraph.js, after a raw loop | State machine with checkpointing and interrupts, which suits approvals. You build the raw loop first so you know what it replaces. | Vercel AI SDK, Mastra, or no framework at all |
| LLM access | Ollama running `qwen3.5:4b` locally, through an OpenAI-compatible adapter behind your own `LLMProvider` interface | Free, private, and offline. The OpenAI-compatible API is the most widely copied format, so the adapter also works with other local servers. The interface keeps you provider-independent and makes testing with a fake provider easy. | LM Studio or llama.cpp server (same API shape), Ollama's native `/api/chat`, or a hosted provider later through the same interface |
| MCP | Official TypeScript MCP SDK | The reference implementation. | None needed |
| OpenAPI parsing | swagger-parser, openapi-types | Reliable `$ref` dereferencing for 3.x specs. | openapi-typescript for generated types |
| Validation | Zod, zod-to-json-schema | One schema language for runtime validation and tool schemas. | Ajv |
| Embeddings | `qwen3-embedding:0.6b` on Ollama, behind an `EmbeddingProvider` interface | Local and free. Its 32K context fits whole tool descriptions, and it is small enough to load next to the chat model. | `nomic-embed-text` or `embeddinggemma` (smaller, but only 2K context) |
| Observability | Langfuse, Pino logs | Open-source LLM tracing with datasets and scores. Self-hosting may be too heavy for 16 GB (see Step 5.3). | OpenTelemetry with another backend, your own audit log |
| Evals | Custom TypeScript runner on Vitest | Full control over scoring and CI gating. | promptfoo, Langfuse datasets |
| Frontend | Next.js, Tailwind, shadcn/ui, SWR | Your strength, so it costs little time. Streaming works through SSE. | Vite and React |
| Testing | Vitest, Supertest, Testcontainers | Fast unit tests and real-database integration tests. | Jest |
| Infra | Docker Compose, GitHub Actions | Everything runs locally with one command. | Kubernetes only later, and only if justified |
| Workflows | n8n (primary), Dify (comparison) | Event-driven automations around the agent API. | Zapier-style tools |

**Rule for Claude Code:** before installing any library or using a framework API, check the current official docs and latest stable versions. LangGraph, MCP, Ollama, and the OpenAI SDK change quickly, so do not rely on memory for exact APIs.

## 3. Architecture

**Repo layout**

```
apps/
  host-store-api/      # demo e-commerce backend (NestJS, Mongo)
  toolbridge-api/      # platform API: tenants, specs, runs, approvals, SSE
  toolbridge-worker/   # BullMQ workers that execute agent runs
  web/                 # Next.js UI
packages/
  shared/              # types, errors, config, logger
  spec-compiler/       # OpenAPI to internal model to tools (pure, no I/O framework)
  mcp-server/          # MCP server over compiled tools
  agent-core/          # LLM port, tool executor, raw loop, LangGraph graph
  retrieval/           # embeddings, tool index, knowledge RAG
  policy/              # RBAC, approval rules, budgets, injection guards
evals/                 # dataset, runner, scorers
specs/                 # host-store.json and public specs for stress tests
infra/                 # docker-compose.yml (mongo, redis, langfuse, n8n)
docs/                  # BUILD_PLAN.md, adr/, learning-log.md, architecture.md
```

**Principles**

1. **Ports and adapters.** Core packages depend on interfaces (`LLMProvider`, `EmbeddingProvider`, `Store`), never on concrete SDKs.
2. **Pure core.** `spec-compiler` and `policy` have no network or database access, so they are trivial to test.
3. **Defense in depth.** Permissions are enforced twice: tools are filtered before the model sees them, and again at execution time.
4. **Untrusted tool output.** Anything returned by a tool is data, never instructions.
5. **Writes are special.** Write-class tools are idempotent, audited, and approval-gated by policy.
6. **Everything observable.** Every run has an id that appears in logs, traces, and the audit log.
7. **Measure before optimizing.** No retrieval or prompt change is kept without an eval number.
8. **Replaceable infrastructure.** Queue, vector store, and LLM can be swapped without touching business logic.

## 4. Rules for Claude Code (copy into CLAUDE.md)

- Read `docs/BUILD_PLAN.md` and work only on the step I name. Do not start the next step.
- Before coding, post a short plan: files to create or change, interfaces, and how we will verify it. Wait for my go-ahead on anything that changes architecture.
- Keep code simple and typed. Prefer small modules with one responsibility. No dead code or speculative abstractions.
- Do not write test files by default. Write a test only when it is really necessary (security, money, data integrity, or an acceptance check that cannot be shown by running commands), and say why. Otherwise verify by running the app, seed or scripts, and list the exact commands so I can re-run them. A step is not done until its acceptance checks pass.
- Check current official docs and versions before adding dependencies or using fast-moving APIs. Justify every new dependency in one line.
- Never commit secrets. Use `.env.example` and validate config at startup.
- Record each non-trivial decision as an ADR in `docs/adr/` with alternatives considered.
- When finished: summarize what changed, how to run it, what I should learn from it, and any shortcuts you took.
- Explain concepts when I ask. Teaching me matters as much as the code.
- If anything is ambiguous, ask one focused question instead of guessing.

* At the end of every step, write a short learning note to the shared learning inbox as described in section 1.2 of the build plan. Keep it under about 400 words and include only links you have actually opened.

## 5. Step-by-step plan

Each step lists what to **Do**, what to **Learn**, and when it is **Done**.

### Phase 0: Foundations and host app

**Step 0.1: Monorepo scaffold** Do: pnpm workspaces and Turborepo, strict TypeScript, ESLint, Prettier, Vitest, Docker Compose (the MongoDB Atlas Local image so vector search works from day one, plus Redis), GitHub Actions for lint, typecheck, and test, `CLAUDE.md`, ADR template, ADR 0001 for the monorepo. Learn: monorepo versus polyrepo, dependency graph between packages. Done: a clean clone runs install, test, and `docker compose up`, and CI is green.

**Step 0.2: Host app domain and seed** Do: `apps/host-store-api` with schemas for products, inventory, customers, orders, refunds, coupons, shipments. A repeatable seed script with about 500 orders, including delayed orders, large refunds, and a few records with injection-style text in notes (used later for red-teaming). Learn: domain modeling and seed design. Done: `pnpm seed` resets and fills the database identically each time.

**Step 0.3: Host app endpoints, auth, and Swagger quality** Do: 35 to 45 endpoints with filters (status, date range, customer) and pagination. JWT auth with roles owner, support, and warehouse, enforced by guards. Risky operations: refund, bulk price update, cancel order. An endpoint returning dynamic order-form field configuration. A real summary, description, and example on every operation. Learn: why filters and descriptions in an API decide how well an agent can use it. Done: Swagger is complete, and each role gets 403 where expected.

**Split Step 0.3 into two sessions.** Step 0.3a covers read endpoints, filters, pagination, auth and roles, and the Swagger descriptions. Step 0.3b covers the risky write endpoints (refund, bulk price update, cancel), the dynamic form-config endpoint, and the 403 tests. Keep each session small enough that you can review all of its code.

**Step 0.4: Spec export and tests** Do: a script that exports `specs/host-store.json`. Supertest e2e tests for auth and refunds. Done: spec committed, tests pass.

### Phase 1: Raw tool-calling loop (`packages/agent-core`)

**Step 1.1: LLM port** Do: an `LLMProvider` interface (generate and stream), message and tool-call types, an OpenAI-compatible adapter pointed at Ollama, env-based config (base URL, model, context length), a fake provider for tests, and an ADR on going local-only. Before writing the adapter, run a quick smoke test: confirm `qwen3.5:4b` returns a well-formed tool call through `/v1/chat/completions`, both streamed and not streamed. Learn: ports and adapters, the tool-use message format, and what an OpenAI-compatible API is. Done: unit tests pass with the fake provider, and one real tool-calling round trip works against the local model.

**Step 1.2: Tools and executor** Do: a `Tool` interface (name, description, Zod schema, safety class), a registry, five hand-written tools calling the host API (list orders, get order, get customer, list products, issue refund), and an executor with timeouts, backoff retries, and normalized errors. Learn: tool design, and why errors go back to the model as results. Done: each tool tested against the local host API.

**Step 1.3: Agent loop and CLI** Do: a framework-free loop (call model, run tool calls in parallel when independent, append results, repeat) with a max-iteration guard, token accounting, and a CLI chat. Small models often emit one tool call at a time, so the loop must work either way. Malformed tool calls are returned to the model as errors, with a retry cap. Learn: the ReAct-style loop and stop conditions. Done: it answers a three-call chained question and recovers from a tool error.

**Step 1.4: Streaming, logging, failure lab** Do: stream tokens and tool events. Add structured Pino logs keyed by run id. Deliberately trigger an oversized result and a paginated result, then add truncation and result shaping. Measure speed and memory at two or three context lengths (for example 8K, 16K, 32K) and pick a default. Learn: context window pressure, and why a local model's context is a memory budget. Done: failures and fixes are written up in the learning log.

### Phase 2: Spec compiler and MCP

**Step 2.1: Spec loader and intermediate model (`packages/spec-compiler`)** Do: load from file or URL, dereference `$ref`s, support OpenAPI 3.x, and normalize into an internal `Operation` model (id, method, path, parameters, body schema, responses, security, tags). Learn: why a compiler needs an intermediate representation. Done: snapshot tests pass on the host spec, and a large public spec parses.

**Step 2.2: Tool generator** Do: naming rules with operationId fallback, description composition, schema simplification (depth limits, trimmed enums, no response-only fields), safety classification (reads versus writes, plus a risk level with a manual override file), and overrides to hide, rename, or merge operations. Learn: tool quality matters more than prompt cleverness. Done: the host spec yields about 40 clean tools in a golden snapshot.

**Step 2.3: HTTP executor** Do: map tool arguments to path, query, header, and body. Propagate auth (caller token or tenant credential). Shape responses (field allowlists, truncation, pagination hints). Map errors. Use an SSRF-safe client that blocks private addresses unless allowlisted. Learn: auth propagation and SSRF. Done: generated tools reproduce the behavior of the five hand-written ones.

**Step 2.4: Spec cache and versioning** Do: hash specs, cache compiled tools by hash, and diff two spec versions (added, removed, changed operations, with a breaking flag). Learn: content-addressed caching. Done: unchanged specs skip recompilation, and diffs are tested.

**Step 2.5: MCP server (`packages/mcp-server`)** Do: expose compiled tools with the official SDK over stdio and streamable HTTP, annotating write tools. Test with the MCP Inspector, then connect one real MCP client (for example Claude Desktop, or a local-model client; check current free options when you get here). Learn: MCP architecture (host, client, server) and tools versus resources versus prompts. Done: the Inspector can list and call every tool, and one MCP client can operate the host app through your server.

**Step 2.6: Platform API (`apps/toolbridge-api`)** Do: tenants, spec upload or URL registration, credential storage encrypted at rest (envelope encryption), and endpoints to list and enable or disable tools. Learn: multi-tenancy models and secrets handling. Done: a test proves two tenants cannot see each other's specs or tools.

### Phase 3: Retrieval (`packages/retrieval`)

**Step 3.1: Tool index** Do: an `EmbeddingProvider` port, a tool-text builder, a vector index in MongoDB, an embedding cache keyed by content hash, and incremental reindex on spec change. Learn: embeddings and vector search basics. Done: changing one operation re-embeds only that operation.

**Step 3.2: Tool retrieval in the loop** Do: select the top k tools per query, always include a small core set, add a fallback when confidence is low. Measure recall@k on the host spec and on a large public spec (Stripe or GitHub), and record the baseline. Learn: why retrieval is needed past a few dozen tools. Done: a baseline recall number is saved.

**Step 3.3: Knowledge RAG** Do: ingest markdown policies (refund policy, shipping rules, escalation guide), chunk by heading with metadata, and add a retrieval tool that returns cited chunks. Answers must cite sources. Learn: chunking strategies and citations. Done: policy questions are answered with correct citations.

**Step 3.4: Measured improvements** Do: try hybrid keyword plus vector search, query rewriting, and reranking. Compare in a results table and keep only what wins. Learn: experiment discipline. Done: a before and after table is in the docs.

### Phase 4: The harness

**Step 4.1: LangGraph graph** Do: state schema, nodes (retrieve tools, call model, execute tools, finalize), and conditional edges. Keep the raw loop as a baseline, compare behavior, and write an ADR on what the framework gave and cost. Check current LangGraph.js docs first. Learn: state, reducers, nodes and edges, prebuilt agents versus custom graphs. Done: the graph passes the same tests as the raw loop.

**Step 4.2: RBAC policy layer (`packages/policy`)** Do: a role-to-tool permission matrix, filtering tools before the model sees them and enforcing again at execution time. Learn: defense in depth. Done: tests show forbidden calls are blocked even when forced.

**Step 4.3: Approvals** Do: risk rules (write class plus thresholds, for example refunds above an amount), interrupt and resume with a checkpointer persisted in MongoDB, approval records, and an API to approve or reject with a reason. Learn: checkpoints, interrupts, durable state. Done: approve and reject paths are tested, and a run can resume after a restart.

**Verify before building:** confirm that a maintained MongoDB checkpointer exists for LangGraph.js. If not, write a small custom one behind the checkpointer interface, or keep checkpoints only in Postgres or Redis, and record the choice in an ADR.

**Step 4.4: Queue, workers, streaming (`apps/toolbridge-worker`)** Do: BullMQ workers, a run API (create, get, cancel, events over SSE), and a persisted event log so a reconnecting client can replay. Learn: at-least-once delivery, dead-letter queues, backpressure. Done: closing the tab does not stop a run, and a killed worker's run is picked up again.

**Step 4.5: Reliability** Do: idempotency keys on write tools with stored results, retry policy by tool class (retry reads, never blindly retry writes), a circuit breaker, and a Redis token-bucket rate limiter per tenant. Learn: idempotency and failure modes of retries. Done: kill a worker between a side effect and its acknowledgement, and no duplicate refund occurs.

**Step 4.6: Budgets** Do: token accounting per run and tenant, with cost derived from a configurable price table (zero for local models, so the same code works if a paid provider is added later). Add token caps with a graceful stop, and a usage endpoint. Learn: budgets as a safety limit, not only a billing feature. Done: a run stops cleanly at its cap.

**Step 4.7: Memory** Do: conversation trimming and summarization, and a long-term user memory store with expiry. Done: long conversations stay within context.

**Step 4.8: Tool-result cache** Do: cache safe reads with TTL, keyed by tenant, role, and arguments, and invalidate on related writes. Learn: cache invalidation. Done: repeated reads hit the cache, and writes invalidate correctly.

**Step 4.9: Prompt-injection defense** Do: mark tool output as untrusted in the prompt structure, flag instruction-like content, and require approval for write calls that follow untrusted content. Build a red-team test set from the poisoned seed records. Learn: why tool output is an attack surface. Done: the poisoned records cause no unauthorized action.

**Step 4.10: Audit log** Do: an append-only record per tool call (who, role, arguments hash, result status, approval id, run id) with a query API. Done: any write action can be traced back to a person and an approval.

### Phase 5: Evals and tracing (`evals/`)

**Step 5.1: Dataset.** 50 cases in JSON: question, role, expected tool sequence, outcome assertions, and tags (multi-step, ambiguous, forbidden, injection, no-data). **Step 5.2: Runner and scoring.** Reset host state per case. Score tool-selection accuracy, argument correctness, task success, step count, tokens, and latency, and report every score per model (`qwen3.5:4b` versus `qwen3.5:9b`). Prefer deterministic checks (tool sequence, database state) over an LLM judge. Use a judge only for free-text answers, with a rubric, run it on the 9B model, and check it by hand on a larger sample because small judges are unreliable. **Step 5.3: Tracing.** Trace every run by run id with Langfuse. Self-hosting runs several containers and may be too heavy for a 16 GB laptop next to the model, so check its current requirements first. If it is too heavy, use a lighter local trace store (your own audit log plus OpenTelemetry) and keep the same run ids. **Step 5.4: CI gate.** CI runners have no GPU, so CI cannot run the local model. Use record and replay: run the real eval suite on your laptop, save the model responses as fixtures, and have CI replay them and score the results. CI then catches regressions in your code (compiler, policy, executor). Re-record locally when you change prompts or models. Fail the build when scores drop below thresholds, store result history, and write an ADR on this choice. Learn: record and replay testing, and what it can and cannot catch. **Step 5.5: Improvement loop.** Make three measured improvements with before and after numbers. Learn: eval design, and why anecdotal testing misleads. Done: the README results table is generated from real runs.

### Phase 6: Workflows

**Step 6.1:** A webhook endpoint with API-key auth that starts a run and calls back on completion. **Step 6.2:** Two n8n workflows (stuck-order investigation with manager approval, and a daily operations digest). **Step 6.3:** Rebuild one flow in Dify and write a comparison of low-code versus code (debuggability, versioning, testing).

### Phase 7: Ship

**Step 7.1:** Stress test on a large public spec and report tool count, compile time, and retrieval accuracy. **Step 7.2:** README, architecture diagram, ADR index, and a clean one-command setup. **Step 7.3:** A 2-minute demo video script and recording. **Step 7.4:** Optional: connect to the notification platform as a bonus demo. **Step 7.5:** Fill the resume bullets with the real numbers.

## 6. UI track (`apps/web`)

Build each screen only when its backend exists. Use shadcn/ui and let Claude Code do most of the work, since this is not your learning focus.

- **U1, Chat:** after Step 4.4. Streaming answers with expandable tool-call cards.
- **U2, Tools manager:** after Step 2.6. Upload a spec, view generated tools, toggle them, and see the role matrix.
- **U3, Approval inbox:** after Step 4.3. Pending writes with exact arguments and approve or reject.
- **U4, Run trace viewer:** after Step 4.10. Timeline with tokens, cost, and latency. If time is short, use Langfuse instead.

## 7. Prompt template for each session

```
Read CLAUDE.md and docs/BUILD_PLAN.md. We are doing Step X.Y only.
1. Post a short plan: files, interfaces, verification commands (tests only where really necessary), and any decision that needs an ADR.
2. Wait for my approval, then implement it and show the commands you ran.
3. Run the acceptance checks and show me the results.
4. Finish with: what changed, how to run it, what I should learn from it, a learning note written to the inbox (section 1.2),
   shortcuts taken, and 3 questions to check my understanding.
Check current official docs before using any library API.
```

## 8. Definition of done for the whole project

- Upload a spec and get a working agent with zero hand-written tools.
- Roles, approvals, idempotency, and crash recovery are demonstrably correct.
- Eval suite runs in CI with published scores.
- README, architecture diagram, ADRs, and a demo video exist.
- You can explain every ADR in your own words.
