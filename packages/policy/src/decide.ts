/**
 * The access decision. Pure: no network, no database, no clock. The same inputs always give the
 * same answer, which makes the security rules easy to test and to reason about.
 *
 * Three rules, in this order:
 * 1. DENY BY DEFAULT: an unknown role, or a tool no allow pattern matches, is denied.
 * 2. DENY WINS: a deny pattern beats any allow pattern, so a broad allow (`orders_*`) can carve
 *    out an exception (`orders_cancel`) safely.
 * 3. Otherwise, a matching allow pattern grants access.
 */
import type { Policy } from './policy.js';

/** Who is asking. `userId` is for logs and audit; only `role` decides access today. */
export interface Principal {
  userId: string;
  role: string;
}

/** The answer, with a reason a person (and the model) can read when access is denied. */
export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decides whether a role may use one tool.
 * Before -> after (with support allowed `orders_*` and denied `orders_cancel`):
 * `('support', 'orders_get')` -> `{ allowed: true }`;
 * `('support', 'orders_cancel')` -> `{ allowed: false, reason: 'Role "support" is denied tool "orders_cancel" (rule "orders_cancel").' }`;
 * `('guest', 'orders_get')` -> `{ allowed: false, reason: 'Role "guest" has no permissions.' }`.
 */
export function decide(policy: Policy, role: string, toolName: string): AccessDecision {
  // `Object.hasOwn`, not `policy.roles[role]`: a role named "constructor" or "__proto__" must not
  // pick up a property inherited from Object.prototype.
  const rules = Object.hasOwn(policy.roles, role) ? policy.roles[role] : undefined;
  if (!rules) return { allowed: false, reason: `Role "${role}" has no permissions.` };

  const denied = rules.deny.find((p) => matches(p, toolName));
  if (denied !== undefined) {
    return {
      allowed: false,
      reason: `Role "${role}" is denied tool "${toolName}" (rule "${denied}").`,
    };
  }
  if (rules.allow.some((p) => matches(p, toolName))) return { allowed: true };
  return { allowed: false, reason: `Role "${role}" is not allowed to use tool "${toolName}".` };
}

/**
 * A ready-to-use authorizer for one policy, in the shape agent-core's ToolAuthorizer port
 * expects. agent-core never imports this package: the app that wires things together does.
 */
export function createAuthorizer(policy: Policy): {
  authorize(principal: Principal, toolName: string): AccessDecision;
} {
  return { authorize: (principal, toolName) => decide(policy, principal.role, toolName) };
}

/**
 * True when a pattern matches the WHOLE tool name; `*` matches any run of characters (also none).
 * Before -> after: `('orders_*', 'orders_get')` -> true; `('orders_*', 'customers_list_orders')`
 * -> false (anchored at the start); `('orders', 'orders_get')` -> false (anchored at the end).
 */
export function matches(pattern: string, toolName: string): boolean {
  // The schema allows only [A-Za-z0-9_*], so no other regex symbol can appear in the pattern.
  const regex = new RegExp(`^${pattern.replaceAll('*', '.*')}$`);
  return regex.test(toolName);
}
