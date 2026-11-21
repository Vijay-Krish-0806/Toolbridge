/**
 * Structured logs for agent runs. Each line is one JSON object, so you can filter by field
 * (for example every line with one runId) instead of searching text.
 */
import { type Logger, pino } from 'pino';
import type { AgentEvent } from '../agent/loop.js';
import type { RetryEvent } from '../tools/executor.js';

/**
 * Creates a logger that appends JSON lines to `filePath`, creating its folder if needed.
 * `sync: true` writes each line straight away: a CLI logs little, and async buffering could lose
 * the last lines when the process exits. `base: undefined` drops pid and hostname from every
 * line, and timestamps are readable ISO strings.
 */
export function createFileLogger(filePath: string): Logger {
  return pino(
    { base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: filePath, sync: true, mkdir: true }),
  );
}

/**
 * Writes one agent event as a log line. Pass a child logger carrying the runId, so every line of
 * a run can be found together. Streaming pieces are skipped: hundreds of one-word lines would
 * bury the useful ones, and the whole answer is logged when the run ends. Tool results are
 * logged by size only, because they can be large and may contain customer data.
 */
export function logAgentEvent(logger: Logger, event: AgentEvent): void {
  switch (event.type) {
    case 'reasoning-delta':
    case 'text-delta':
      return;
    case 'tools-selected':
      logger.info(
        {
          mode: event.selection.mode,
          topScore: event.selection.topScore,
          offered: event.offered,
        },
        'tools-selected',
      );
      return;
    case 'llm-response': {
      const { result } = event;
      logger.info(
        {
          iteration: event.iteration,
          durationMs: Math.round(event.durationMs),
          finishReason: result.finishReason,
          toolCalls: result.message.toolCalls.map((call) => call.name),
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        },
        'llm-response',
      );
      return;
    }
    case 'tool-start':
      logger.debug(
        { tool: event.call.name, toolCallId: event.call.id, arguments: event.call.arguments },
        'tool-start',
      );
      return;
    case 'tool-end': {
      const base = {
        tool: event.call.name,
        toolCallId: event.call.id,
        arguments: event.call.arguments,
        durationMs: Math.round(event.durationMs),
      };
      if (event.result.ok) {
        logger.info({ ...base, ok: true, resultChars: event.result.content.length }, 'tool-end');
      } else {
        const { code, status, message } = event.result.error;
        logger.warn({ ...base, ok: false, errorCode: code, status, error: message }, 'tool-end');
      }
      return;
    }
  }
}

/** Logs a tool attempt that failed and is about to be retried (from the executor's onRetry hook). */
export function logToolRetry(logger: Logger, event: RetryEvent): void {
  logger.warn(
    {
      tool: event.toolName,
      attempt: event.attempt,
      errorCode: event.error.code,
      error: event.error.message,
      delayMs: event.delayMs,
    },
    'tool-retry',
  );
}
