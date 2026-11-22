# ADR-0035: Persisted run events and an SSE stream with replay

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.4a needs a run API that clients can follow live: a persisted event log with a sequence number per event, so that a reconnecting client replays what it missed; a documented, versioned public schema (`text_delta`, `tool_call_started`, `tool_call_finished`, `approval_required`, `run_finished`); and no internal events on the wire. Session (a) moved runs to worker processes (ADR 0034), so the process that produces events (a worker) is not the one that serves the client (the API). ADR 0027 requires streams to use `fetch` with an `Authorization` header, never a token in the URL.

## Decision

**Workers write public events to a MongoDB log, numbered by an atomic per-run counter. The API serves `GET /runs/:id/events` as Server-Sent Events: stored events first, then new ones, woken by Redis pub/sub.**

- **Schema package `packages/run-events`** (zod): envelope `{ v: 1, runId, seq, at, type, data }` and the five types; additive changes keep `v: 1`. Documented in `docs/run-events.md`; the widget (U1b) will import the same package.
- **Mapping in the worker** (`EventSink`): the model's text becomes `text_delta`, combined for about 100 ms; `tool-start` and `tool-end` become the tool events, with no result content; the pause becomes `approval_required`; the end becomes `run_finished`. Reasoning, raw model results, the tool menu and tool results are dropped there.
- **Numbering:** `seq` comes from `$inc` on the run record (a new `TenantScoped.incrementOne`), so any writer gets a unique next number: the worker, and the API when it cancels a waiting run. Events are unique on `(tenantId, runId, seq)`.
- **Order:** a leg writes its events one at a time on a promise chain and waits for all of them before it ends, also when it throws, so `run_finished` never gets a smaller number than the text before it.
- **Stream:** `id`, `event` and `data` lines per event. Resume with `Last-Event-ID` or `?after=`. A 15 s heartbeat; it closes after `run_finished`. The run is looked up tenant-scoped first, so another tenant gets 404. A reader moves its cursor only over consecutive numbers; a missing number is waited for 5 s, then skipped.
- **Live updates:** after storing an event the writer publishes the run id on a prefixed Redis channel; each API process has one subscriber shared by all its streams. A 2 s poll covers a lost message, so pub/sub only makes it faster and never decides correctness.
- **Backpressure:** the stream waits for `drain` when the client is slow. The worker never waits for a client, because it writes to the log.

## Alternatives considered

- **WebSockets.** Not chosen: the stream is one-way (server to client), SSE works over plain HTTP with proxies and has `Last-Event-ID` built in, and actions (approve, cancel) are ordinary requests.
- **Redis Streams as the log** (`XADD` ids as cursors). Fast and made for this. Not chosen: a second store of record next to MongoDB, with its own retention and persistence settings. Runs, cards, audit rows and checkpoints already live in MongoDB; Redis stays a queue and a signal.
- **Numbering in worker memory.** One write per event instead of two. Not chosen: after a takeover the new worker must find the last number, and a second writer (the API cancelling a waiting run) would need coordination; the atomic counter needs neither.
- **Push events straight from worker to client** (no log). Not chosen: nothing to replay after a reconnect, and the run would slow to the speed of the slowest client.
- **MongoDB change streams instead of pub/sub.** Possible on Atlas Local. Not chosen for now: one cursor per open stream on the database; pub/sub plus a poll is simpler and the log stays the truth.

## Consequences

- **Positive (e2e over real HTTP with fetch):** numbers 1..N with no gaps and every event valid against the schema; no reasoning or tool-result text on the wire (the test fails when reasoning is let through); a reconnect with `Last-Event-ID` or `?after=` gets exactly the missed events (fails when the header is ignored); closing the stream does not stop the run; the card and the approved write arrive across two connections; a cancelled waiting run ends with `run_finished` `cancelled`; another tenant gets 404.
- **Negative:** two writes per event (counter and event), kept small by combining text; after a worker takeover the interrupted model turn's text can be streamed again under new numbers (documented limitation); the log grows with every run (no expiry yet: checkpoint and run TTL are on the v3 list).
- **Follow-ups:** Step 4.4b replaces the tenant key on the stream with a session token and adds per-tenant CORS origins; U1b and U1a read this stream.
