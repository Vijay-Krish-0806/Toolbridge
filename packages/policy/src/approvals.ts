/**
 * Approval rules (Step 4.3): which tool calls must wait for a person before they run. Pure: the
 * same calls always get the same answer.
 *
 * Rules, in order:
 * 1. Reads never need approval (they change nothing).
 * 2. For a write, the FIRST rule whose tool pattern (and optional threshold) matches decides.
 * 3. A write no rule matches gets the policy's `default`, which is `required` unless the policy
 *    says otherwise: safe by default.
 * A model turn can make several calls; the turn is approved as one batch, and the STRICTEST
 * level in it decides who may approve (`high` beats `required` beats `none`).
 */
import { matches } from './decide.js';
import type { ApprovalLevel, ApprovalRule, Policy } from './policy.js';

/** One tool call to check: the tool's name and safety class, and the call's parsed arguments. */
export interface CallToCheck {
  name: string;
  safety: 'read' | 'write';
  args: Record<string, unknown>;
}

/** The level for one call, with a reason a person can read on the approval card. */
export interface CallApproval {
  level: ApprovalLevel;
  reason: string;
}

/** The level for a whole turn, plus each call's own level and reason (same order as the calls). */
export interface BatchApproval {
  level: ApprovalLevel;
  calls: CallApproval[];
}

const STRICTNESS: Record<ApprovalLevel, number> = { none: 0, required: 1, high: 2 };

/**
 * Decides one call.
 * Before -> after (host-store rules):
 * `{ name: 'orders_get', safety: 'read' }` -> `{ level: 'none', reason: 'Reads never need approval.' }`;
 * `{ name: 'refunds_request', safety: 'write', args: { amountCents: 32893 } }` ->
 * `{ level: 'high', reason: 'refunds_request with amountCents above 10000 needs high approval (policy rule).' }`;
 * the same with `amountCents: 500` -> `{ level: 'required', reason: 'Every write needs approval by default.' }`.
 */
export function approvalFor(policy: Policy, call: CallToCheck): CallApproval {
  if (call.safety === 'read') return { level: 'none', reason: 'Reads never need approval.' };
  const rule = policy.approvals.rules.find((r) => ruleMatches(r, call));
  if (rule) return { level: rule.approval, reason: describeRule(rule, call.name) };
  return {
    level: policy.approvals.default,
    reason:
      policy.approvals.default === 'none'
        ? 'Writes need no approval by default in this policy.'
        : 'Every write needs approval by default.',
  };
}

/**
 * Decides a whole turn: each call's level, and the strictest one for the batch.
 * Before -> after: `[orders_get (read), refunds_request 32893]` ->
 * `{ level: 'high', calls: [{ level: 'none', ... }, { level: 'high', ... }] }`. No calls -> `none`.
 */
export function batchApproval(policy: Policy, calls: CallToCheck[]): BatchApproval {
  const decided = calls.map((call) => approvalFor(policy, call));
  const level = decided.reduce<ApprovalLevel>(
    (strictest, c) => (STRICTNESS[c.level] > STRICTNESS[strictest] ? c.level : strictest),
    'none',
  );
  return { level, calls: decided };
}

/**
 * A ready-to-use approval checker for one policy, in the shape agent-core's ApprovalPolicy port
 * expects. agent-core never imports this package: the app that wires things together does.
 */
export function createApprovalPolicy(policy: Policy): {
  evaluate(calls: CallToCheck[]): BatchApproval;
} {
  return { evaluate: (calls) => batchApproval(policy, calls) };
}

/**
 * True when a rule applies to a call: a tool pattern matches and, if the rule has a threshold,
 * the argument is a number above it. A missing or non-numeric argument does not match, so the
 * call falls through to later rules or the default (never to a looser level by accident).
 */
function ruleMatches(rule: ApprovalRule, call: CallToCheck): boolean {
  if (!rule.tools.some((p) => matches(p, call.name))) return false;
  if (rule.arg === undefined || rule.above === undefined) return true;
  const value = call.args[rule.arg];
  return typeof value === 'number' && value > rule.above;
}

/** The reason text for a matched rule, for example "refunds_request with amountCents above 10000.". */
function describeRule(rule: ApprovalRule, toolName: string): string {
  const threshold =
    rule.arg === undefined || rule.above === undefined
      ? ''
      : ` with ${rule.arg} above ${String(rule.above)}`;
  const what = rule.approval === 'none' ? 'needs no approval' : `needs ${rule.approval} approval`;
  return `${toolName}${threshold} ${what} (policy rule).`;
}
