/**
 * The manual overrides file: a human's corrections on top of the automatic rules. Hide plumbing
 * operations, rename tools, raise a risk level, or merge several lookups into one tool.
 * Validated with Zod, and strict, so a typo such as "hiden" fails loudly instead of being ignored.
 */
import { z } from 'zod';

const RiskLevel = z.enum(['low', 'medium', 'high']);

const OperationOverride = z.strictObject({
  hidden: z.boolean().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  safety: z.enum(['read', 'write']).optional(),
  risk: RiskLevel.optional(),
  /**
   * Which response fields the model sees. For a list (or a page of items) it applies to each
   * item. Dot paths reach into nested objects, for example "order.number".
   */
  result: z.strictObject({ fields: z.array(z.string()).min(1) }).optional(),
});

const MergeRule = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** Operation ids, in the order 2.3 should try them. */
  operations: z.array(z.string()).min(2),
  risk: RiskLevel.optional(),
});

export const OverridesSchema = z.strictObject({
  /** Keyed by operation id (the IR's `Operation.id`). */
  operations: z.record(z.string(), OperationOverride).default({}),
  merge: z.array(MergeRule).default([]),
});

export type Overrides = z.output<typeof OverridesSchema>;
export type OperationOverride = z.output<typeof OperationOverride>;
export type MergeRule = z.output<typeof MergeRule>;

/** Thrown when an overrides file does not match the schema. */
export class OverridesError extends Error {
  override readonly name = 'OverridesError';
}

/**
 * Checks parsed JSON against the overrides schema and fills in defaults.
 * Before -> after: `{ operations: { X: { hidden: true } } }` -> same, plus `merge: []`.
 */
export function parseOverrides(json: unknown): Overrides {
  const result = OverridesSchema.safeParse(json);
  if (!result.success) {
    throw new OverridesError(`Invalid overrides file:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
