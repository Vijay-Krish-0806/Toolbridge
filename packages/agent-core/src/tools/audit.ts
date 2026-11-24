/**
 * The audit port (Step 4.10). The executor reports every call to a ToolAuditor; the app decides
 * where the record goes (the platform writes MongoDB rows). agent-core never sees a database.
 *
 * Write-ahead for writes: `started` is awaited BEFORE a write tool runs. If it throws, the write
 * does not run (fail closed): a write we cannot record must not happen. Every call, refused ones
 * included, then gets `finished` with its outcome.
 */
import { createHash } from 'node:crypto';

import type { ToolErrorCode } from './errors.js';
import type { SafetyClass } from './tool.js';

/**
 * Thrown by `ToolAuditor.started` when this exact write (same run, call id and arguments) has
 * already started once: the run is being retried after a crash, and the first attempt may have
 * reached the API. The executor does not run it again (Step 4.4a).
 */
export class WriteAlreadyStartedError extends Error {
  override readonly name = 'WriteAlreadyStartedError';
}

/**
 * Thrown by an executor's `credentialFor` when the identity a call must run under is not
 * available (Step 4.4c: the user's session expired or was revoked). The call is refused with
 * `credential_unavailable`; it never falls back to another identity.
 */
export class CredentialUnavailableError extends Error {
  override readonly name = 'CredentialUnavailableError';
}

/** What the executor knows about a call. Who asked and why is added by the app's adapter. */
export interface AuditedCall {
  callId: string;
  toolName: string;
  /** null when the tool name is unknown (the call is refused). */
  safety: SafetyClass | null;
  /** sha256 of the exact argument string (see hashArguments). */
  argsHash: string;
}

/** How a call ended: `ok`, or the error code it returned. */
export interface AuditOutcome {
  status: 'ok' | ToolErrorCode;
  durationMs: number;
  /** Step 4.8: the result came from the cache, so nothing was sent to the API. */
  cached: boolean;
}

export interface ToolAuditor {
  /**
   * Before a write runs. Throwing refuses the write: `WriteAlreadyStartedError` gives
   * `outcome_unknown`, any other error `audit_unavailable`.
   */
  started(call: AuditedCall): Promise<void>;
  /**
   * After every call. Should not throw; if it does, the executor ignores the error, because the
   * call already happened and the model must still get its result.
   */
  finished(call: AuditedCall, outcome: AuditOutcome): Promise<void>;
}

/**
 * sha256 (hex) of the arguments exactly as the model sent them: the same string the approval
 * card shows, so anyone can check that the write that ran is the write that was approved, while
 * the audit log itself stores no customer data.
 * Before -> after: '{"orderId":"ORD-7","amountCents":500}' -> '9c1f…' (64 hex characters).
 */
export function hashArguments(argumentsJson: string): string {
  return createHash('sha256').update(argumentsJson, 'utf8').digest('hex');
}
