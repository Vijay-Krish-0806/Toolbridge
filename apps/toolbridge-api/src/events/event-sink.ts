import { Logger } from '@nestjs/common';
import type { AgentEvent } from '@toolbridge/agent-core';
import type { RunEventBody } from '@toolbridge/run-events';
import type { Types } from 'mongoose';

import type { EventLog } from './event-log.js';

/** How long text pieces are collected before they become one `text_delta` event. */
const TEXT_FLUSH_MS = 100;

/**
 * Turns one leg's internal agent events into public run events and writes them to the log,
 * IN ORDER, one at a time (Step 4.4a).
 *
 * - The graph emits events synchronously (`onEvent` returns nothing), so writes are queued on a
 *   promise chain: each starts after the previous one finished, so the numbers match the order.
 * - Text arrives a few characters at a time; it is collected for about 100 ms and written as one
 *   `text_delta`, so a long answer is tens of events, not thousands. Any other event writes the
 *   pending text first, so text and tool events never swap places.
 * - Internal events (reasoning, raw model results, the tool menu, tool results) are dropped
 *   here: the public schema never sees them.
 * - A failed write is logged and skipped: a missing progress event must not fail the run.
 */
export class EventSink {
  private readonly logger = new Logger(EventSink.name);
  private chain: Promise<void> = Promise.resolve();
  private text = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: EventLog,
    private readonly tenantId: Types.ObjectId,
    private readonly runId: string,
  ) {}

  /** The leg's `onEvent`: maps an internal event to a public one (or drops it). */
  readonly onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'text-delta':
        this.text += event.text;
        this.timer ??= setTimeout(() => {
          this.flushText();
        }, TEXT_FLUSH_MS);
        return;
      case 'tool-start':
        this.push({
          type: 'tool_call_started',
          data: { callId: event.call.id, tool: event.call.name, arguments: event.call.arguments },
        });
        return;
      case 'tool-end':
        this.push({
          type: 'tool_call_finished',
          data: {
            callId: event.call.id,
            tool: event.call.name,
            ok: event.result.ok,
            ...(!event.result.ok && { errorCode: event.result.error.code }),
            durationMs: Math.round(event.durationMs),
          },
        });
        return;
      default:
        return; // reasoning, llm-response, tools-selected: internal only
    }
  };

  /** Queues one public event (after any pending text). */
  push(body: RunEventBody): void {
    this.flushText();
    this.enqueue(body);
  }

  /** Writes everything still pending; resolves when the log has all of this leg's events. */
  async flush(): Promise<void> {
    this.flushText();
    await this.chain;
  }

  private flushText(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.text === '') return;
    const text = this.text;
    this.text = '';
    this.enqueue({ type: 'text_delta', data: { text } });
  }

  private enqueue(body: RunEventBody): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.log.append(this.tenantId, this.runId, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Run ${this.runId}: event ${body.type} not stored: ${message}`);
      }
    });
  }
}
