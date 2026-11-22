/** The kinds of failure the model can see. Each has a clear next step for the model or the caller. */
export type ToolErrorCode =
  | 'unknown_tool' // the model invented a tool name
  | 'invalid_arguments' // bad JSON or failed schema validation: the model should fix its call
  | 'timeout' // the tool took too long
  | 'network' // could not reach the API at all
  | 'http_error' // the API answered with an error status (see `status`)
  | 'blocked' // refused for safety before sending (private address, bad path, redirect)
  | 'cancelled' // the caller cancelled the call (for example an MCP client)
  | 'forbidden' // the person's role may not use this tool (Step 4.2): do not retry, explain
  | 'audit_unavailable' // the write could not be recorded first, so it did not run (Step 4.10)
  | 'outcome_unknown' // this exact write already started once (a retried run); not run again (4.4a)
  | 'internal'; // a bug in our own tool code

/** A failure in the normalized shape that goes back to the model. */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** True when trying the same call again might succeed (timeouts, 5xx, 429, network). */
  retryable: boolean;
  /** HTTP status, when the API answered. */
  status?: number;
}

/**
 * Thrown by tool code (for example the host API client) when it already knows how to classify
 * the failure. The executor turns it into a ToolError unchanged.
 */
export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  /** `retryable` and `status` are optional details; most errors are not retryable. */
  constructor(
    code: ToolErrorCode,
    message: string,
    details: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
  }
}

/** Raised when the executor's time limit for one attempt runs out. */
export class ToolTimeoutError extends Error {
  /** `timeoutMs` is the limit that was exceeded, kept in the message for the model to read. */
  constructor(timeoutMs: number) {
    super(`Tool timed out after ${String(timeoutMs)} ms`);
    this.name = 'ToolTimeoutError';
  }
}

/** Raised when the caller cancels a running tool call (its AbortSignal fired). */
export class ToolCancelledError extends Error {
  /** Fixed message: the model or client only needs to know it was cancelled on purpose. */
  constructor() {
    super('Tool call was cancelled by the caller');
    this.name = 'ToolCancelledError';
  }
}
