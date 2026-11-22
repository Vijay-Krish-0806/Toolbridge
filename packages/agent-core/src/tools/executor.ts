import { z } from 'zod';
import type { Principal, ToolAuthorizer } from '../agent/access.js';
import type { ToolCall } from '../llm/types.js';
import {
  type AuditedCall,
  hashArguments,
  type ToolAuditor,
  WriteAlreadyStartedError,
} from './audit.js';
import {
  ToolCancelledError,
  type ToolError,
  ToolExecutionError,
  ToolTimeoutError,
} from './errors.js';
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
  /** Longest result (in characters) sent to the model; longer results are cut with a note. */
  maxResultChars?: number;
  /**
   * Step 4.2: when set, every call is checked against it before anything else happens, and a
   * call without a principal is refused (fail closed). This is the last line of defense: it
   * holds even if the agent offered a forbidden tool by mistake, or a caller skips the agent.
   */
  authorizer?: ToolAuthorizer;
  /**
   * Step 4.10: when set, every call is reported to it, and a write runs only after its
   * `started` record was saved (write-ahead, fail closed). See tools/audit.ts.
   */
  audit?: ToolAuditor;
}

/** Per-call options for `ToolExecutor.run`. */
export interface RunOptions {
  /** Lets the caller cancel the call. */
  signal?: AbortSignal;
  /** Who is asking. Required when the executor has an authorizer. */
  principal?: Principal;
}

/** Runs tool calls from the model safely: validate, run with a timeout, retry reads, normalize errors. */
export class ToolExecutor {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxResultChars: number;
  private readonly authorizer: ToolAuthorizer | undefined;
  private readonly audit: ToolAuditor | undefined;

  /** Defaults: 10 s per attempt, 2 retries, 250 ms first backoff delay, 8,000-character results. */
  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.onRetry = options.onRetry;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    this.authorizer = options.authorizer;
    this.audit = options.audit;
  }

  /**
   * Runs one tool call and always returns a ToolResult. Steps:
   * 1. check access (when an authorizer is set), 2. find the tool by name, 3. parse the arguments
   * JSON, 4. validate with the tool's Zod schema, 5. execute with a timeout, retrying retryable
   * failures of read tools with backoff.
   * Access comes first, so a forbidden call learns nothing (not even whether its arguments were
   * valid) and an unknown name is refused the same way as a forbidden one.
   * `signal` lets the caller cancel (for example an MCP client cancelling a request): the running
   * attempt is aborted, the result is a 'cancelled' error, and nothing is retried.
   * With an auditor, the call is recorded around all of this (see `audited`).
   */
  async run(call: ToolCall, options: RunOptions = {}): Promise<ToolResult> {
    if (!this.audit) return this.attempt(call, options);
    return this.audited(this.audit, call, options);
  }

  /**
   * Runs a call with an audit record: `finished` for every call (refused ones too), and for a
   * write also `started`, inside `attempt`, right before the tool runs.
   */
  private async audited(
    audit: ToolAuditor,
    call: ToolCall,
    options: RunOptions,
  ): Promise<ToolResult> {
    const startedAt = performance.now();
    const entry: AuditedCall = {
      callId: call.id,
      toolName: call.name,
      safety: this.registry.get(call.name)?.safety ?? null,
      argsHash: hashArguments(call.arguments),
    };
    const result = await this.attempt(call, options, { audit, entry });
    const outcome = {
      status: result.ok ? ('ok' as const) : result.error.code,
      durationMs: Math.round(performance.now() - startedAt),
    };
    try {
      await audit.finished(entry, outcome);
    } catch {
      // The call already happened; the model still gets its result (see ToolAuditor.finished).
    }
    return result;
  }

  /** The checks and the execution, as described on `run`. */
  private async attempt(
    call: ToolCall,
    options: RunOptions,
    audit?: { audit: ToolAuditor; entry: AuditedCall },
  ): Promise<ToolResult> {
    const { signal } = options;
    const denied = this.checkAccess(call.name, options.principal);
    if (denied) return denied;

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
    // Write-ahead: a write runs only once its audit record is saved.
    if (audit && tool.safety === 'write') {
      try {
        await audit.audit.started(audit.entry);
      } catch (error) {
        if (error instanceof WriteAlreadyStartedError) {
          // Never twice: the first attempt may have reached the API before the process died.
          return fail(
            'outcome_unknown',
            'This action was already started once and may have been done. It was not run again; ' +
              'check the current state before trying again.',
          );
        }
        return fail(
          'audit_unavailable',
          'The action could not be recorded in the audit log, so it was not run. Try again later.',
        );
      }
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const output = await withTimeout(
          (attemptSignal) => tool.execute(parsed.data, { signal: attemptSignal }),
          this.timeoutMs,
          signal,
        );
        const content = JSON.stringify(output ?? null);
        return { ok: true, content: truncateResult(content, this.maxResultChars) };
      } catch (thrown) {
        const error = toToolError(thrown);
        // Never retry writes: if the first attempt reached the server, a retry could repeat it.
        const canRetry =
          error.retryable &&
          tool.safety === 'read' &&
          attempt <= this.maxRetries &&
          signal?.aborted !== true;
        if (!canRetry) return { ok: false, error };

        const delayMs = backoffDelay(this.baseDelayMs, attempt);
        this.onRetry?.({ toolName: tool.name, attempt, error, delayMs });
        await this.sleep(delayMs);
      }
    }
  }

  /**
   * The access check. Returns a `forbidden` result to send back, or undefined when the call may
   * go ahead. No authorizer means access control is off (tests, local scripts).
   * Before -> after: (warehouse, 'refunds_request') ->
   * `{ ok: false, error: { code: 'forbidden', message: 'Role "warehouse" is not allowed ...' } }`.
   */
  private checkAccess(toolName: string, principal: Principal | undefined): ToolResult | undefined {
    if (!this.authorizer) return undefined;
    if (!principal) {
      return fail('forbidden', 'No user identity was given for this call, so it was refused.');
    }
    const decision = this.authorizer.authorize(principal, toolName);
    return decision.allowed ? undefined : fail('forbidden', decision.reason);
  }
}

/**
 * About 2,000 to 2,500 tokens: room for several results in a 16K context. Ollama silently drops
 * messages that do not fit (the failure lab saw a 59,122-character result vanish completely), so
 * it is far better to send part of a result with a clear note than to lose all of it.
 */
export const DEFAULT_MAX_RESULT_CHARS = 8_000;

/**
 * Cuts `content` to at most `maxChars` and adds a note telling the model what happened and what to
 * do instead. The cut JSON is no longer valid JSON, but the model can still read it, and the note
 * makes the gap explicit:
 *   59,122 chars  ->  first 8,000 chars + "... [truncated: showed 8000 of 59122 characters. ...]"
 * Shorter content is returned unchanged.
 */
export function truncateResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return (
    `${content.slice(0, maxChars)}... [truncated: showed ${String(maxChars)} of ` +
    `${String(content.length)} characters. Use filters or a smaller page to see the rest.]`
  );
}

/** Shorthand for a failed result with a non-retryable error. */
function fail(code: ToolError['code'], message: string): ToolResult {
  return { ok: false, error: { code, message, retryable: false } };
}

/**
 * Runs `run` but rejects with ToolTimeoutError after `timeoutMs`. The signal is aborted too, so a
 * tool that passes it to fetch stops the request. The race guarantees the limit even if a tool
 * ignores the signal. If the caller's `parent` signal fires first, the attempt is aborted and
 * rejected with ToolCancelledError instead.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new ToolTimeoutError(timeoutMs);
  const cancelledError = new ToolCancelledError();
  let timer: NodeJS.Timeout | undefined;
  let onCancel: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    onCancel = () => {
      controller.abort(cancelledError);
      reject(cancelledError);
    };
    if (parent?.aborted === true) onCancel();
    else parent?.addEventListener('abort', onCancel, { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    if (onCancel) parent?.removeEventListener('abort', onCancel);
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
  if (thrown instanceof ToolCancelledError) {
    return { code: 'cancelled', message: thrown.message, retryable: false };
  }
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
