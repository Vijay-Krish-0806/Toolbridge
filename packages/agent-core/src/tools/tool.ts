import type { z } from 'zod';

import type { AuthProvider } from '../openapi/auth.js';

/**
 * How dangerous a tool is. `read` tools only look at data, so running one twice is harmless.
 * `write` tools change data, so the executor never retries them automatically (a retry could
 * refund twice). Later phases add approvals and idempotency on top of this.
 */
export type SafetyClass = 'read' | 'write';

export interface ToolContext {
  /** Fires when the executor's timeout expires. Pass it to fetch so slow calls are really cancelled. */
  signal: AbortSignal;
  /**
   * Step 4.4c: the credential for THIS call, chosen per call by the executor's `credentialFor`
   * (user delegation: the requester's or the approver's own host token). When set, a tool that
   * calls an API uses it instead of the credential it was created with.
   */
  auth?: AuthProvider;
  /**
   * Step 4.5: the idempotency key of THIS call, derived from durable state (the same on every
   * retry and after a takeover). A tool that calls an API sends it, so the API does the write
   * only once however often the request arrives.
   */
  idempotencyKey?: string;
}

/**
 * One action the model can take. `input` is a Zod schema with two jobs: it becomes the JSON Schema
 * the model reads, and it validates the arguments the model sends back before `execute` runs.
 */
export interface Tool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  safety: SafetyClass;
  input: Schema;
  /**
   * Step 4.7: true for a tool that runs inside the platform and never calls the tenant's API. The
   * executor then leaves out what protects that API (circuit breaker, call rate, the user's
   * credential, idempotency key). Access checks and the audit log apply as always.
   */
  local?: boolean;
  /**
   * Step 4.7: true for a tool whose work is done once it has succeeded. The graph then takes it
   * off the menu for the rest of the run. Found live: a small model repeated a successful
   * `memory_save` until the run hit its limit, and prompt wording did not stop it reliably.
   */
  once?: boolean;
  /**
   * The exact JSON Schema to show the model. Optional: when absent, the registry derives it from
   * `input`. Generated tools set it, because their schema already is JSON Schema and a round trip
   * through Zod could change it.
   */
  parameters?: Record<string, unknown>;
  /** Runs the tool with already-validated input. Its return value is sent to the model as JSON. */
  execute(input: z.output<Schema>, context: ToolContext): Promise<unknown>;
}

/**
 * Identity helper that exists only for typing: it lets TypeScript infer `execute`'s input type
 * from the `input` schema, so tool authors get autocompletion without writing types twice.
 */
export function defineTool<Schema extends z.ZodType>(tool: Tool<Schema>): Tool<Schema> {
  return tool;
}
