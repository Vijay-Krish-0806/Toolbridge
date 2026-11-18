import type { z } from 'zod';

/**
 * How dangerous a tool is. `read` tools only look at data, so running one twice is harmless.
 * `write` tools change data, so the executor never retries them automatically (a retry could
 * refund twice). Later phases add approvals and idempotency on top of this.
 */
export type SafetyClass = 'read' | 'write';

export interface ToolContext {
  /** Fires when the executor's timeout expires. Pass it to fetch so slow calls are really cancelled. */
  signal: AbortSignal;
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
