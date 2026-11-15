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

**Cost guard:** set a monthly spend cap on the API key before Step 1.1. Read the model name from an environment variable and default to a cheaper model while developing. Enable prompt caching for tool definitions. Tests use the fake provider, so they cost nothing. Never commit keys.

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
| LLM access | Anthropic API via the official SDK, behind your own `LLMProvider` interface | The interface keeps you provider-independent and makes testing with a fake provider easy. | Any other provider through the same interface |
| MCP | Official TypeScript MCP SDK | The reference implementation. | None needed |
| OpenAPI parsing | swagger-parser, openapi-types | Reliable `$ref` dereferencing for 3.x specs. | openapi-typescript for generated types |
| Validation | Zod, zod-to-json-schema | One schema language for runtime validation and tool schemas. | Ajv |
| Embeddings | Behind an `EmbeddingProvider` interface | Anthropic offers no embedding model of its own. Voyage AI is commonly paired with Claude, and OpenAI or a local model through Ollama also work. Check current options when you reach Phase 3. | Any |
| Observability | Langfuse (self-hosted in Docker), Pino logs | Open-source LLM tracing with datasets and scores. | OpenTelemetry with another backend, LangSmith |
| Evals | Custom TypeScript runner on Vitest | Full control over scoring and CI gating. | promptfoo, Langfuse datasets |
| Frontend | Next.js, Tailwind, shadcn/ui, SWR | Your strength, so it costs little time. Streaming works through SSE. | Vite and React |
| Testing | Vitest, Supertest, Testcontainers | Fast unit tests and real-database integration tests. | Jest |
| Infra | Docker Compose, GitHub Actions | Everything runs locally with one command. | Kubernetes only later, and only if justified |
| Workflows | n8n (primary), Dify (comparison) | Event-driven automations around the agent API. | Zapier-style tools |

**Rule for Claude Code:** before installing any library or using a framework API, check the current official docs and latest stable versions. LangGraph, MCP, and the Anthropic SDK change quickly, so do not rely on memory for exact APIs.

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
- Before coding, post a short plan: files to create or change, interfaces, and tests. Wait for my go-ahead on anything that changes architecture.
- Keep code simple and typed. Prefer small modules with one responsibility. No dead code or speculative abstractions.
- Write tests alongside code. A step is not done until its acceptance checks pass.
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

**Step 1.1: LLM port** Do: an `LLMProvider` interface (generate and stream), message and tool-call types, an Anthropic adapter, env-based config, and a fake provider for tests. Learn: ports and adapters, the tool-use message format. Done: unit tests pass with the fake provider, and one real call works.

**Step 1.2: Tools and executor** Do: a `Tool` interface (name, description, Zod schema, safety class), a registry, five hand-written tools calling the host API (list orders, get order, get customer, list products, issue refund), and an executor with timeouts, backoff retries, and normalized errors. Learn: tool design, and why errors go back to the model as results. Done: each tool tested against the local host API.

**Step 1.3: Agent loop and CLI** Do: a framework-free loop (call model, run tool calls in parallel when independent, append results, repeat) with a max-iteration guard, token accounting, and a CLI chat. Learn: the ReAct-style loop and stop conditions. Done: it answers a three-call chained question and recovers from a tool error.

**Step 1.4: Streaming, logging, failure lab** Do: stream tokens and tool events. Add structured Pino logs keyed by run id. Deliberately trigger an oversized result and a paginated result, then add truncation and result shaping. Learn: context window pressure. Done: failures and fixes are written up in the learning log.

### Phase 2: Spec compiler and MCP

**Step 2.1: Spec loader and intermediate model (`packages/spec-compiler`)** Do: load from file or URL, dereference `$ref`s, support OpenAPI 3.x, and normalize into an internal `Operation` model (id, method, path, parameters, body schema, responses, security, tags). Learn: why a compiler needs an intermediate representation. Done: snapshot tests pass on the host spec, and a large public spec parses.

**Step 2.2: Tool generator** Do: naming rules with operationId fallback, description composition, schema simplification (depth limits, trimmed enums, no response-only fields), safety classification (reads versus writes, plus a risk level with a manual override file), and overrides to hide, rename, or merge operations. Learn: tool quality matters more than prompt cleverness. Done: the host spec yields about 40 clean tools in a golden snapshot.

**Step 2.3: HTTP executor** Do: map tool arguments to path, query, header, and body. Propagate auth (caller token or tenant credential). Shape responses (field allowlists, truncation, pagination hints). Map errors. Use an SSRF-safe client that blocks private addresses unless allowlisted. Learn: auth propagation and SSRF. Done: generated tools reproduce the behavior of the five hand-written ones.

**Step 2.4: Spec cache and versioning** Do: hash specs, cache compiled tools by hash, and diff two spec versions (added, removed, changed operations, with a breaking flag). Learn: content-addressed caching. Done: unchanged specs skip recompilation, and diffs are tested.

**Step 2.5: MCP server (`packages/mcp-server`)** Do: expose compiled tools with the official SDK over stdio and streamable HTTP, annotating write tools. Test with the MCP Inspector and Claude Desktop. Learn: MCP architecture (host, client, server) and tools versus resources versus prompts. Done: Claude Desktop can operate the host app through your server.

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

**Step 4.6: Budgets** Do: token and cost accounting per run and tenant, caps with a graceful stop, and a usage endpoint. Done: a run stops cleanly at its cap.

**Step 4.7: Memory** Do: conversation trimming and summarization, and a long-term user memory store with expiry. Done: long conversations stay within context.

**Step 4.8: Tool-result cache** Do: cache safe reads with TTL, keyed by tenant, role, and arguments, and invalidate on related writes. Learn: cache invalidation. Done: repeated reads hit the cache, and writes invalidate correctly.

**Step 4.9: Prompt-injection defense** Do: mark tool output as untrusted in the prompt structure, flag instruction-like content, and require approval for write calls that follow untrusted content. Build a red-team test set from the poisoned seed records. Learn: why tool output is an attack surface. Done: the poisoned records cause no unauthorized action.

**Step 4.10: Audit log** Do: an append-only record per tool call (who, role, arguments hash, result status, approval id, run id) with a query API. Done: any write action can be traced back to a person and an approval.

### Phase 5: Evals and tracing (`evals/`)

**Step 5.1: Dataset.** 50 cases in JSON: question, role, expected tool sequence, outcome assertions, and tags (multi-step, ambiguous, forbidden, injection, no-data). **Step 5.2: Runner and scoring.** Reset host state per case. Score tool-selection accuracy, argument correctness, task success, step count, cost, and latency. Use an LLM judge only for free-text answers, with a rubric, and compare it to manual checks on a sample. **Step 5.3: Tracing.** Self-host Langfuse and trace every run by run id. **Step 5.4: CI gate.** Fail the build when scores drop below thresholds, and store result history. **Step 5.5: Improvement loop.** Make three measured improvements with before and after numbers. Learn: eval design, and why anecdotal testing misleads. Done: the README results table is generated from real runs.

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
1. Post a short plan: files, interfaces, tests, and any decision that needs an ADR.
2. Wait for my approval, then implement it with tests.
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
