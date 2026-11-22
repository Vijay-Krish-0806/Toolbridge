# ADR-0034: Run queue, workers and crash recovery

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Until Step 4.4a, agent runs executed in the background inside the API process (ADR 0031). That breaks three things the build plan needs: a run must keep going when the browser tab closes and when the API restarts, a dead process's run must be picked up again, and every run must be bounded in time (Step 4.3b found a local model streaming for over 20 minutes with no limit). Redis 8.10 is already in the local infrastructure.

Measured and read before deciding (2026-11-22):

- BullMQ 6.7.2 (released 2026-11-07; latest 6.7.8 is 3 days old, so the repo pins one at least two weeks old) with ioredis 6.0.0, now an explicit peer dependency. From its 6.7.2 type definitions: `lockDuration` 30000 ms, `stalledInterval` 30000 ms, `maxStalledCount` 1; the processor receives `(job, token, signal)`; `close(force?)`. From the docs: a duplicate custom `jobId` is ignored, ids may not contain ":", `UnrecoverableError` fails a job without retry, `worker.cancelJob` only reaches jobs of the same Worker object.
- LangGraph.js 1.7.5: a crashed run continues with input `null` on the same thread ("loads the latest checkpoint and retries unfinished work"); nodes that finished in the interrupted super-step are not re-run, but the failed node runs again from its start (at-least-once, so side effects must be idempotent). From the 1.7.5 source: the `signal` in the run config is combined into every task's signal; `durability` defaults to `"async"`.

## Decision

**Runs execute on worker processes fed by a BullMQ queue. A leg reads the run's checkpoint to decide whether to start, continue or resume, so it is safe to deliver twice. A write that already started in a lost attempt is never repeated.**

- **Two programs, one codebase:** `apps/toolbridge-api` (HTTP) and `apps/toolbridge-worker` (no HTTP). Shared domain code lives in a `PlatformModule` in toolbridge-api; the worker boots `WorkerModule`, exported as `@toolbridge/toolbridge-api/worker`. The API only saves the run record and enqueues.
- **Jobs are legs:** `start-<runId>` and `resume-<approvalId>` (a repeated request cannot queue a leg twice). A job carries ids only; the worker loads principal, spec and card from MongoDB.
- **At-least-once, made safe:** a leg checks the checkpoint first: no checkpoint means start; unfinished work means `continueAgentRun` (input `null`); a resume job resumes only if the run is paused on _that_ card (same call ids), otherwise it only records what an earlier attempt already reached. Card creation reuses an open card. Status updates are conditional on `status: 'running'`. Checkpoints use `durability: "sync"`, so a crash never loses a step that already happened.
- **Never twice (required test):** the write-ahead audit row (ADR 0032) gets a unique partial index on `(tenantId, runId, callId, argsHash)` for `started` rows. When a retried leg reaches a write that already started, the insert fails, the executor returns `outcome_unknown` ("may have been done; check before trying again") and does not call the API.
- **Bounds:** `LLM_MAX_OUTPUT_TOKENS` (default 4096) is sent as `max_tokens` on every model call; `RUN_LEG_TIMEOUT_MS` (default 10 min) aborts the leg through one AbortSignal that LangGraph passes to every node, and our nodes pass to the model request and the tool calls. A timed-out run is marked failed ("time limit") and not retried.
- **Failures:** an ordinary error is retried (3 attempts, exponential backoff from 2 s); after the last attempt the job stays in BullMQ's failed set (the dead-letter queue) and the run is marked failed. A dead worker stops renewing its lock; after `WORKER_LOCK_MS` another worker takes the job over.
- **Cancel:** `POST /runs/:id/cancel`. A waiting run is cancelled at once and its card closed (`cancelled`, no longer approvable). A running run gets `cancelRequested` and a Redis pub/sub message; the worker running it aborts the leg's signal. A queued leg sees the flag when it starts.
- **Removed:** the in-process background legs and the API's startup rule that failed `running` runs (both from ADR 0031); stalled-job takeover replaces the rule and works with any number of API and worker instances.
- **Not used:** LangGraph's per-node `timeout` option. The leg deadline already reaches the model call through the signal; one bound is easier to reason about.

## Alternatives considered

- **Keep runs in the API process.** Not chosen: a restart kills every running leg, and scaling the API scales the agent work with it.
- **Extract the domain code into a new package first.** Not chosen for now: a large move for no behaviour change; the worker entry export keeps the deploy boundary without it.
- **Exactly-once delivery** (locks or transactions around a leg). Not available end to end: the host API is outside our transaction. At-least-once plus idempotent legs plus the write guard is the standard answer; host idempotency keys (Step 4.5) complete it.
- **Repeat a started write after a crash.** Not chosen: a refund that reached the host would be paid twice. Refusing with `outcome_unknown` can lose a write that never reached the host; a person can retry it knowingly, which is the safe failure.
- **Cancel with BullMQ's `worker.cancelJob`.** Not enough alone: it only reaches the same Worker object. Pub/sub reaches every worker process.

## Consequences

- **Positive:** e2e with real worker processes killed by SIGKILL: the run is taken over and finishes; a worker killed during a refund does not have it repeated (one refund at the fake host, `outcome_unknown` in the audit log; removing the guard makes the test fail); a hung model is stopped at the time limit and not retried; running and waiting runs can be cancelled; a leg that keeps failing is tried 3 times and the run is marked failed.
- **Negative:** a write whose outcome is unknown needs a person to check; a stalled-but-alive worker ("zombie") can keep running its leg until its own signal or the time limit, while another worker continues the run; BullMQ's lock makes the zombie's final job update fail, but not its side effects (the write guard covers writes). Model call ids are part of the guard key, so a model that repeats the same call id with the same arguments later in the run is refused too.
- **Follow-ups:** session (b) adds the persisted event log, the public event schema and the stream with replay; Step 4.5 adds host idempotency keys; production needs Redis persistence (AOF) and `maxmemory-policy noeviction` (BullMQ going-to-production guide).
