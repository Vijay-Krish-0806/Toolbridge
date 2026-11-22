import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RunEvent } from '@toolbridge/run-events';
import type { Types } from 'mongoose';

import type { EventLog } from './event-log.js';

/** Seconds between keep-alive comments, so proxies do not close an idle stream. */
const HEARTBEAT_MS = 15_000;
/** Longest wait for news before reading the log again (covers a lost Redis announcement). */
const POLL_MS = 2_000;
/**
 * How long a missing number is waited for before it is skipped. Normally events are written in
 * order, so a gap only appears for a moment (or with a leftover worker writing in parallel).
 */
const GAP_WAIT_MS = 5_000;

/**
 * Streams one run's events over Server-Sent Events (Step 4.4a), starting after `after`:
 * first everything already in the log, then new events as they are written, until
 * `run_finished` is sent or the client goes away.
 *
 * Wire format (one block per event, a blank line between):
 *   id: 7
 *   event: tool_call_started
 *   data: {"v":1,"runId":"…","seq":7,...}
 * A client that reconnects sends `Last-Event-ID: 7` (or `?after=7`) and gets 8 onwards.
 *
 * BACKPRESSURE: `res.write` returns false when the client reads slower than we write; we then
 * wait for 'drain' before writing more. The run itself never waits for a client: the worker
 * writes to the log, and each stream reads the log at its own pace.
 */
export async function streamRunEvents(
  log: EventLog,
  tenantId: Types.ObjectId,
  runId: string,
  after: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // tell nginx-style proxies not to buffer the stream
  });
  res.flushHeaders();

  // Set in a callback, so the loop asks a function each time instead of trusting a narrowed value.
  let clientGone = false;
  // A plain listener, not events.once(): once() REJECTS when the socket emits 'error' (a client
  // that disconnects mid-stream can, with ECONNRESET), and an unhandled rejection would stop the
  // whole process. Here a disconnect only ever resolves.
  const gone = new Promise<void>((resolve) => {
    req.once('close', () => {
      clientGone = true;
      resolve();
    });
  });
  req.on('error', () => undefined); // a reset connection is a normal way for a client to leave
  const isGone = () => clientGone;
  let wake: (() => void) | undefined;
  const unsubscribe = await log.subscribe(runId, () => wake?.());
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  /** Writes one chunk, waiting for 'drain' (or the client leaving) when the buffer is full. */
  const write = async (chunk: string): Promise<void> => {
    if (!res.write(chunk)) {
      await Promise.race([new Promise<void>((resolve) => res.once('drain', resolve)), gone]);
    }
  };

  let cursor = after;
  let gapSince: number | undefined;
  try {
    while (!isGone()) {
      let finished = false;
      for (const event of await log.read(tenantId, runId, cursor)) {
        if (event.seq !== cursor + 1) {
          gapSince ??= Date.now();
          if (Date.now() - gapSince < GAP_WAIT_MS) break; // wait for the missing number
          cursor = event.seq - 1; // it never came: skip it rather than stall the stream
        }
        gapSince = undefined;
        await write(format(event));
        cursor = event.seq;
        if (event.type === 'run_finished') {
          finished = true;
          break;
        }
        if (isGone()) break;
      }
      if (finished) break;
      // Sleep until the run's next announcement, the poll interval, or the client leaving.
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, gapSince === undefined ? POLL_MS : 250);
        }),
        gone,
      ]);
      wake = undefined;
    }
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
}

/** One event as an SSE block. */
function format(event: RunEvent): string {
  return `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The resume point from `Last-Event-ID` (preferred) or `?after=`; 0 = from the start. */
export function resumePoint(lastEventId: string | undefined, after: string | undefined): number {
  const value = Number(lastEventId ?? after ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
