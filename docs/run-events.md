# Run events (v1)

The public event stream of a ToolBridge agent run. The schema lives in `packages/run-events` (zod); this page describes it for client authors, for example the chat widget.

## Endpoint

```
GET /runs/:runId/events
Authorization: Bearer <key>
Last-Event-ID: <seq>        (optional: resume after this event)
```

- The response is Server-Sent Events (`text/event-stream`).
- Send the key in the `Authorization` header with `fetch`. Never put a token in the URL. The browser's `EventSource` cannot set headers, so use `fetch` and read the body as a stream.
- Until Step 4.4b the key is the tenant API key. From 4.4b it is a short-lived session token.
- `?after=<seq>` does the same as `Last-Event-ID`.
- Another tenant's run returns 404.
- The server sends a comment line (`: ping`) every 15 s, so proxies keep the connection open.
- The stream closes after `run_finished`.
- A run waiting for approval keeps its stream open, so a client may disconnect and come back later.

Each event is one block:

```
id: 7
event: tool_call_started
data: {"v":1,"runId":"3f2c…","seq":7,"at":"2026-11-22T10:00:00.000Z","type":"tool_call_started","data":{...}}
```

## Envelope

| Field   | Meaning                                                             |
| ------- | ------------------------------------------------------------------- |
| `v`     | Schema version, `1`.                                                |
| `runId` | The run.                                                            |
| `seq`   | 1, 2, 3, … per run, with no gaps. Send the last one back to resume. |
| `at`    | ISO 8601 time the event was stored.                                 |
| `type`  | One of the types below.                                             |
| `data`  | The type's fields.                                                  |

## Types

| `type`               | `data`                                                                                                     | When                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `text_delta`         | `text`                                                                                                     | A piece of the answer. Pieces are combined about every 100 ms; concatenate them. |
| `tool_call_started`  | `callId`, `tool`, `arguments` (JSON text)                                                                  | The agent calls a tool.                                                          |
| `tool_call_finished` | `callId`, `tool`, `ok`, `errorCode?`, `durationMs`                                                         | The call ended. No result content is sent.                                       |
| `approval_required`  | `approvalId`, `level` (`required` or `high`), `calls[]` (`callId`, `tool`, `arguments`, `level`, `reason`) | The run paused for a person. All calls are approved or rejected together.        |
| `run_finished`       | `status` (`completed`, `failed` or `cancelled`), `answer?`, `stopReason?`, `error?`                        | The last event.                                                                  |

These are not exposed: the model's reasoning, raw model results, tool results, and the tool menu.

## Versioning

- Adding an optional field or a new event type keeps `v: 1`. Clients must ignore types and fields they do not know.
- Removing a field, renaming one, or changing its meaning makes a new version.

## Delivery guarantees

- **Ordered and gap-free.** Events are stored before they are sent, so a reconnect with the last `seq` returns exactly the missed ones, with no repeats.
- **The run does not depend on the client.** Closing the tab only ends that stream; the run continues on a worker.
- **Known limitation: a repeated turn after a takeover.** If a worker dies in the middle of a model turn, another worker runs that turn again. The client may then see that turn's `text_delta` text twice, as new events with new numbers.

## Example (browser or Node 18+)

```js
async function follow(runId, key, lastSeq = 0, onEvent) {
  const res = await fetch(`/runs/${runId}/events`, {
    headers: { authorization: `Bearer ${key}`, 'last-event-id': String(lastSeq) },
  });
  if (!res.ok) throw new Error(`stream refused: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return lastSeq; // closed after run_finished, or the network dropped: call again
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue; // heartbeat
      const event = JSON.parse(line.slice(6));
      lastSeq = event.seq;
      onEvent(event);
    }
  }
}
```
