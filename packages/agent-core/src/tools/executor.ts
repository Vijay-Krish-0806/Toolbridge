import { z } from 'zod';
import type { Principal, ToolAuthorizer } from '../agent/access.js';
import type { ToolCall } from '../llm/types.js';
import type { AuthProvider } from '../openapi/auth.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import {
  type AuditedCall,
  CredentialUnavailableError,
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
import { forgivingCache, type ToolResultCache } from './result-cache.js';
import type { Tool } from './tool.js';

/**
 * What a tool call produced. It is always a value, never an exception: errors are sent back to
 * the model as results so it can correct itself (for example, fix a bad argument).
 * `cached` is set when the result came from the cache (Step 4.8).
 */
export type ToolResult =
  { ok: true; content: string; cached?: true } | { ok: false; error: ToolError };

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
  /**
   * Step 4.4c: picks the credential for each call (for example the requester's own host token,
   * or the approver's for an approved write). Runs after the access and argument checks and
   * before the write-ahead audit row; throwing CredentialUnavailableError refuses the call with
   * `credential_unavailable`. Unset: tools use the credential they were created with.
   */
  credentialFor?: (call: ToolCall) => Promise<AuthProvider | undefined>;
  /**
   * Step 4.5: the idempotency key of a WRITE call, when the API supports keys. It must come from
   * durable state (for example run id, call id and arguments), so a retried attempt or a worker
   * that takes the run over sends the same key and the API performs the write once. With a key,
   * a write may be retried on a retryable error, and a write that had already started is sent
   * again (the API replays its stored answer) instead of being refused as `outcome_unknown`.
   */
  idempotencyKeyFor?: (call: ToolCall) => string | undefined;
  /**
   * Step 4.5: the circuit breaker of the API these tools call. While it is open, calls fail at
   * once with `circuit_open` (nothing is sent); every attempt's outcome is reported to it.
   */
  breaker?: CircuitBreaker;
  /**
   * Step 4.5: asks for one unit of the tenant's call rate (a token bucket, for example in Redis).
   * A short wait (up to 2 s) is waited out; a longer one refuses the call with `rate_limited`.
   */
  rateLimit?: () => Promise<{ allowed: boolean; retryAfterMs: number }>;
  /**
   * Step 4.8: the cache for successful results of read tools. Asked only after the access,
   * argument and credential checks, so a hit needs the same rights as a real call; every write
   * invalidates it. A cache that fails is ignored. See tools/result-cache.ts.
   */
  cache?: ToolResultCache;
}

/** Per-call options for `ToolExecutor.run`. */
export interface RunOptions {
  /** Lets the caller cancel the call. */
  signal?: AbortSignal;
  /** Who is asking. Required when the executor has an authorizer. */
  principal?: Principal;
}

/**
 * Tells the breaker how an attempt went: network errors, timeouts and retryable HTTP errors
 * (5xx, 429) mean the API is unwell; any other answer (a 4xx) means it is working.
 */
function report(breaker: CircuitBreaker | undefined, error: ToolError): void {
  if (!breaker) return;
  const unwell =
    error.code === 'network' ||
    error.code === 'timeout' ||
    (error.code === 'http_error' && error.retryable);
  if (unwell) breaker.recordFailure();
  else if (error.code === 'http_error') breaker.recordSuccess();
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
  private readonly credentialFor:
    ((call: ToolCall) => Promise<AuthProvider | undefined>) | undefined;
  private readonly idempotencyKeyFor: ((call: ToolCall) => string | undefined) | undefined;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly rateLimit:
    (() => Promise<{ allowed: boolean; retryAfterMs: number }>) | undefined;
  private readonly cache: ToolResultCache | undefined;

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
    this.credentialFor = options.credentialFor;
    this.idempotencyKeyFor = options.idempotencyKeyFor;
    this.breaker = options.breaker;
    this.rateLimit = options.rateLimit;
    this.cache = options.cache && forgivingCache(options.cache);
  }

  /**
   * Runs one tool call and always returns a ToolResult. Steps:
   * 1. check access (when an authorizer is set), 2. find the tool by name, 3. parse the arguments
   * JSON, 4. validate with the tool's Zod schema, 5. pick the credential, 6. answer a read from the
   * cache if it can, 7. execute with a timeout, retrying retryable failures of read tools with
   * backoff.
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
      cached: result.ok && result.cached === true,
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
    // The identity this call runs under (Step 4.4c). Picked before the audit row is written, so a
    // call that cannot get its credential leaves no "started" row behind; and before the cache, so
    // a user whose session has ended gets no cached data either (Step 4.8). A local tool (Step 4.7)
    // does not call the tenant's API, so this and the next steps are not about it.
    let auth: AuthProvider | undefined;
    try {
      auth = tool.local ? undefined : await this.credentialFor?.(call);
    } catch (error) {
      if (error instanceof CredentialUnavailableError) {
        return fail(
          'credential_unavailable',
          `${error.message} The action was not run; the user must sign in again.`,
        );
      }
      throw error;
    }

    // Step 4.8: the cache, for reads. Before the breaker and the rate, because a hit sends nothing.
    const cache = tool.local ? undefined : this.cache;
    const found =
      tool.safety === 'read'
        ? await cache?.lookup({ callId: call.id, toolName: tool.name, args: parsed.data })
        : undefined;
    if (found?.hit) return { ok: true, content: found.content, cached: true };

    // Step 4.5: the API's circuit and the tenant's rate, checked before anything is recorded or
    // sent, so a call stopped here leaves no "started" row and reaches no API.
    const breaker = tool.local ? undefined : this.breaker;
    if (breaker?.state() === 'open') return this.circuitOpen();
    const limited = tool.local ? undefined : await this.takeRate();
    if (limited) return limited;

    // Step 4.5: a write's idempotency key, when the API supports keys.
    const idempotencyKey =
      tool.safety === 'write' && !tool.local ? this.idempotencyKeyFor?.(call) : undefined;

    // Write-ahead: a write runs only once its audit record is saved.
    if (audit && tool.safety === 'write') {
      try {
        await audit.audit.started(audit.entry);
      } catch (error) {
        if (error instanceof WriteAlreadyStartedError && idempotencyKey !== undefined) {
          // Started before (a retried run), but keyed: sending it again is safe, because the API
          // does the write once per key and replays its stored answer. We get the real outcome.
        } else if (error instanceof WriteAlreadyStartedError) {
          // Never twice: the first attempt may have reached the API before the process died.
          return fail(
            'outcome_unknown',
            'This action was already started once and may have been done. It was not run again; ' +
              'check the current state before trying again.',
          );
        } else {
          return fail(
            'audit_unavailable',
            'The action could not be recorded in the audit log, so it was not run. Try again later.',
          );
        }
      }
    }

    const send = () =>
      this.send(
        tool,
        (attemptSignal) =>
          tool.execute(parsed.data, {
            signal: attemptSignal,
            ...(auth && { auth }),
            ...(idempotencyKey !== undefined && { idempotencyKey }),
          }),
        { breaker, keyed: idempotencyKey !== undefined, signal },
      );
    if (tool.safety === 'read') {
      const result = await send();
      if (result.ok && found) await found.store(result.content);
      return result;
    }
    // Step 4.8: a write makes everything cached for this API old. Before it, in case this process
    // dies in the middle; and after it, for reads that ran meanwhile. Also when it failed: a write
    // that timed out may still have been done.
    await cache?.invalidate();
    try {
      return await send();
    } finally {
      await cache?.invalidate();
    }
  }

  /**
   * Runs a checked call against its API: attempts with a timeout, the circuit breaker around each
   * one, and retries with backoff. `keyed`: the write carries an idempotency key.
   */
  private async send(
    tool: Tool,
    execute: (attemptSignal: AbortSignal) => Promise<unknown>,
    options: {
      breaker: CircuitBreaker | undefined;
      keyed: boolean;
      signal: AbortSignal | undefined;
    },
  ): Promise<ToolResult> {
    const { breaker, keyed, signal } = options;
    for (let attempt = 1; ; attempt++) {
      if (breaker && !breaker.allow()) return this.circuitOpen();
      try {
        const output = await withTimeout(execute, this.timeoutMs, signal);
        breaker?.recordSuccess();
        const content = JSON.stringify(output ?? null);
        return { ok: true, content: truncateResult(content, this.maxResultChars) };
      } catch (thrown) {
        const error = toToolError(thrown);
        report(breaker, error);
        // RETRY POLICY BY TOOL CLASS (Step 4.5): reads are retried; a write only when it carries
        // an idempotency key (the API then does it once however often it arrives). A write
        // without a key is never retried: if the first attempt reached the server, a retry
        // could repeat it.
        const safeToRepeat = tool.safety === 'read' || keyed;
        const canRetry =
          error.retryable && safeToRepeat && attempt <= this.maxRetries && signal?.aborted !== true;
        if (!canRetry) return { ok: false, error };

        const delayMs = backoffDelay(this.baseDelayMs, attempt);
        this.onRetry?.({ toolName: tool.name, attempt, error, delayMs });
        await this.sleep(delayMs);
      }
    }
  }

  private circuitOpen(): ToolResult {
    const seconds = Math.ceil((this.breaker?.retryAfterMs() ?? 0) / 1000);
    return fail(
      'circuit_open',
      `The API is failing, so calls to it are paused for about ${String(seconds)} s. Nothing was sent; try again later.`,
    );
  }

  /**
   * Takes one unit of the tenant's rate. Waits out short waits (backpressure: the run slows
   * down instead of failing); a long wait, or three in a row, refuses the call.
   */
  private async takeRate(): Promise<ToolResult | undefined> {
    if (!this.rateLimit) return undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { allowed, retryAfterMs } = await this.rateLimit();
      if (allowed) return undefined;
      if (retryAfterMs > 2000) break;
      await this.sleep(retryAfterMs);
    }
    return fail(
      'rate_limited',
      'Too many tool calls right now for this account. Nothing was sent; try again in a moment.',
    );
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
