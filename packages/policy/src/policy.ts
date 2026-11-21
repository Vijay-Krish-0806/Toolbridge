/**
 * The RBAC policy: which role may use which tools (Step 4.2, ADR 0026).
 *
 * A policy file belongs to one spec, because tool names come from that spec:
 *   {
 *     "version": 1,
 *     "roles": {
 *       "owner":     { "allow": ["*"] },
 *       "warehouse": { "allow": ["shipments_*", "orders_get"], "deny": ["shipments_deliver"] }
 *     }
 *   }
 * Patterns are whole tool names, where `*` stands for any run of characters.
 *
 * The file is checked when it is loaded, so a typo fails at startup instead of silently
 * granting or removing access at run time.
 */
import { z } from 'zod';

/**
 * A tool-name pattern: letters, digits and underscores (the tool-name alphabet) plus `*`.
 * Anything else, such as a space or a regex symbol, is a mistake in the file and is rejected.
 */
const pattern = z
  .string()
  .regex(/^[A-Za-z0-9_*]+$/, 'Use tool-name characters and * only, for example "orders_*".');

const roleRules = z.strictObject({
  /** Tools this role may use. Empty or missing means none. */
  allow: z.array(pattern).default([]),
  /** Tools this role may never use, even when an allow pattern matches. Deny wins. */
  deny: z.array(pattern).default([]),
});

export const policySchema = z.strictObject({
  version: z.literal(1),
  /** Role name -> its rules. A role that is not listed here has no access at all. */
  roles: z.record(z.string().min(1), roleRules),
});

export type Policy = z.infer<typeof policySchema>;
export type RoleRules = z.infer<typeof roleRules>;

/**
 * Checks raw JSON (for example a parsed policy file) and returns a typed policy, or throws with
 * every problem listed.
 * Before -> after: `{ version: 1, roles: { owner: { allow: ['*'] } } }` ->
 * `{ version: 1, roles: { owner: { allow: ['*'], deny: [] } } }`;
 * `{ roles: { owner: { allow: ['orders get'] } } }` -> throws (missing version, bad pattern).
 */
export function parsePolicy(raw: unknown): Policy {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid policy:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
