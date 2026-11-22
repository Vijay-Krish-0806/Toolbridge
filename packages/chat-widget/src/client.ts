/**
 * The run API client the widget uses (Step 7.0, U1b). No DOM here: only fetch, so the same code
 * runs in a browser and in Node (src/demo/check.ts drives it against the real stack).
 *
 * Three rules from the run API (docs/run-events.md):
 * - the session token goes in the `Authorization` header, never in a URL;
 * - the stream is replayable: after any disconnect, reconnect with `Last-Event-ID: <last seq>`
 *   and the server sends exactly the missed events;
 * - session tokens are short-lived, so a fresh one is asked for before the old one expires.
 */
import type { RunEvent } from '@toolbridge/run-events';

import { SseParser } from './sse.js';

/** What the host's own server returns from its "give me a ToolBridge session" endpoint. */
export interface SessionToken {
  token: string;
  /** ISO time. */
  expiresAt: string;
}

/** Asks the HOST's server for a session token (the host's backend holds the API key, never us). */
export type GetToken = () => Promise<SessionToken>;

/** A refusal from the run API, with its status (401, 403, 404, 422, ...). */
export class RunApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RunApiError';
  }
}

/** Renew a token this long before it expires. */
const RENEW_MS = 60_000;
/** Reconnect delays after a dropped stream: 1 s, 2 s, 4 s, then every 10 s. */
const BACKOFF_MS = [1000, 2000, 4000, 10_000];

export class RunClient {
  private cached: SessionToken | undefined;

  constructor(
    private readonly apiBase: string,
    private readonly getToken: GetToken,
  ) {}

  /** Starts a run for the signed-in user; returns its id. */
  async startRun(message: string): Promise<string> {
    const response = await this.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    return ((await response.json()) as { runId: string }).runId;
  }

  /**
   * Follows a run's events from after `after` until `run_finished`, calling `onEvent` for each in
   * order, and returns the last one. A dropped connection is retried with the last sequence
   * number, so no event is lost or repeated; `signal` stops following (the run itself goes on).
   */
  async follow(
    runId: string,
    onEvent: (event: RunEvent) => void,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<RunEvent> {
    let last = options.after ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(`/runs/${encodeURIComponent(runId)}/events`, {
          headers: { 'last-event-id': String(last) },
          ...(options.signal && { signal: options.signal }),
        });
        const finished = await this.read(response, (event) => {
          last = event.seq;
          attempt = 0;
          onEvent(event);
        });
        if (finished) return finished;
      } catch (error) {
        // A refusal (404, 403, 422) or our own stop is final; a network error is retried.
        if (options.signal?.aborted || (error instanceof RunApiError && error.status !== 401)) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[Math.min(attempt, 3)]));
    }
  }

  /** Reads one stream until it closes; returns `run_finished` if it came. */
  private async read(
    response: Response,
    onEvent: (event: RunEvent) => void,
  ): Promise<RunEvent | undefined> {
    if (!response.body) return undefined;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      for (const block of parser.push(value)) {
        // Check the version on the raw JSON first: a future schema version is skipped, not misread.
        const raw = JSON.parse(block.data) as { v?: unknown };
        if (raw.v !== 1) continue;
        const event = raw as RunEvent;
        onEvent(event);
        if (event.type === 'run_finished') {
          await reader.cancel();
          return event;
        }
      }
    }
  }

  /** One authorized request; a 401 drops the cached token so the next attempt gets a new one. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.token();
    const response = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
    if (response.ok) return response;
    if (response.status === 401) this.cached = undefined;
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message : response.statusText;
    throw new RunApiError(response.status, message);
  }

  /** A token that is good for at least another minute. */
  private async token(): Promise<string> {
    if (!this.cached || Date.parse(this.cached.expiresAt) - Date.now() < RENEW_MS) {
      this.cached = await this.getToken();
    }
    return this.cached.token;
  }
}
