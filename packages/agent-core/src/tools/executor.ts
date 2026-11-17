import { z } from 'zod';
import type { ToolCall } from '../llm/types.js';
import { type ToolError, ToolExecutionError, ToolTimeoutError } from './errors.js';
import type { ToolRegistry } from './registry.js';

/**
 * What a tool call produced. It is always a value, never an exception: errors are sent back to
 * the model as results so it can correct itself (for example, fix a bad argument).
 */
export type ToolResult = { ok: true; content: string } | { ok: false; error: ToolError };

/** Details of a failed attempt that will be retried, for logging. */
export interface RetryEvent {
  toolName: string;
  attempt: number;
  error: ToolError;
  delayMs: number;
}

export interface ToolExecutorOptions {
  /** Time limit for one attempt. */
  timeoutMs?: number;
  /** Extra attempts after the first, for retryable errors on read tools only. */
  maxRetries?: number;
  /** First backoff delay. It doubles on each retry, with jitter. */
  baseDelayMs?: number;
  /** Called before each retry. */
  onRetry?: (event: RetryEvent) => void;
  /** How to wait between retries. Tests pass a no-op so they run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs tool calls from the model safely: validate, run with a timeout, retry reads, normalize errors. */
export class ToolExecutor {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Defaults: 10 s per attempt, 2 retries, 250 ms first backoff delay. */
  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.onRetry = options.onRetry;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Runs one tool call and always returns a ToolResult. Steps:
   * 1. find the tool by name, 2. parse the arguments JSON, 3. validate with the tool's Zod schema,
   * 4. execute with a timeout, retrying retryable failures of read tools with backoff.
   */
  async run(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return fail(
        'unknown_tool',
        `Unknown tool "${call.name}". Available tools: ${this.registry.names().join(', ')}.`,
      );
    }

    let rawArgs: unknown;
    try {
      // Some models send an empty string for "no arguments".
      rawArgs = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch {
      return fail('invalid_arguments', `Arguments are not valid JSON: ${call.arguments}`);
    }
    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return fail(
        'invalid_arguments',
        `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
      );
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const output = await withTimeout(
          (signal) => tool.execute(parsed.data, { signal }),
          this.timeoutMs,
        );
        return { ok: true, content: JSON.stringify(output ?? null) };
      } catch (thrown) {
        const error = toToolError(thrown);
        // Never retry writes: if the first attempt reached the server, a retry could repeat it.
        const canRetry = error.retryable && tool.safety === 'read' && attempt <= this.maxRetries;
        if (!canRetry) return { ok: false, error };

        const delayMs = backoffDelay(this.baseDelayMs, attempt);
        this.onRetry?.({ toolName: tool.name, attempt, error, delayMs });
        await this.sleep(delayMs);
      }
    }
  }
}

/** Shorthand for a failed result with a non-retryable error. */
function fail(code: ToolError['code'], message: string): ToolResult {
  return { ok: false, error: { code, message, retryable: false } };
}

/**
 * Runs `run` but rejects with ToolTimeoutError after `timeoutMs`. The signal is aborted too, so a
 * tool that passes it to fetch stops the request. The race guarantees the limit even if a tool
 * ignores the signal.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new ToolTimeoutError(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exponential backoff with jitter: about base x 2^(attempt-1), randomized between 50% and 100%.
 * Doubling gives a struggling server room to recover; jitter stops many clients retrying in sync.
 */
function backoffDelay(baseDelayMs: number, attempt: number): number {
  const ceiling = baseDelayMs * 2 ** (attempt - 1);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/** Converts anything a tool threw into the normalized ToolError shape. Unknown errors are our bugs. */
function toToolError(thrown: unknown): ToolError {
  if (thrown instanceof ToolTimeoutError) {
    return { code: 'timeout', message: thrown.message, retryable: true };
  }
  if (thrown instanceof ToolExecutionError) {
    return {
      code: thrown.code,
      message: thrown.message,
      retryable: thrown.retryable,
      ...(thrown.status !== undefined && { status: thrown.status }),
    };
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return { code: 'internal', message: `Tool failed unexpectedly: ${message}`, retryable: false };
}
