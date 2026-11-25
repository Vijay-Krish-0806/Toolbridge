/**
 * The approval port and its data (Step 4.3, ADR 0031). agent-core asks "does this turn need a
 * person's approval?" through `ApprovalPolicy` and never knows how the answer is made. Adapter:
 * `createApprovalPolicy` in packages/policy. The app that wires the pieces passes it in.
 *
 * A model turn is approved as ONE batch (all or nothing): the card lists every call with its exact
 * arguments, and the strictest call decides who may approve.
 */
import { z } from 'zod';

import type { Exposure, FlaggedCall } from './exposure.js';

/** `required`: a person must approve. `high`: someone other than the requester must approve. */
export type ApprovalLevel = 'none' | 'required' | 'high';

/** One call to check: tool name, safety class, and the call's parsed arguments. */
export interface CallToCheck {
  name: string;
  safety: 'read' | 'write';
  args: Record<string, unknown>;
  /** A platform tool that never reaches the tenant's API (see Tool.local). */
  local?: boolean;
}

export interface ApprovalPolicy {
  /**
   * Decides a turn: the strictest level, and each call's own level and reason, in call order.
   * `exposure` is what the model had read before it wrote these calls (Step 4.9).
   */
  evaluate(
    calls: CallToCheck[],
    exposure: Exposure,
  ): {
    level: ApprovalLevel;
    calls: { level: ApprovalLevel; reason: string }[];
  };
}

/** One call on the approval card. `id` is the model's call id: one audit row (4.10) per call. */
export interface PendingCall {
  id: string;
  name: string;
  /** The exact arguments the model wrote, unchanged, so the approver sees what will run. */
  arguments: string;
  level: ApprovalLevel;
  reason: string;
}

/** What the run pauses with: the approval card. This is the `interrupt()` value. */
export interface ApprovalRequest {
  /** The strictest level in the batch (never `none`: a batch that needs nothing does not pause). */
  level: 'required' | 'high';
  /** Host user id of the person who asked; empty when the run has no identity. */
  requesterId: string;
  calls: PendingCall[];
  /** Step 4.9: what the model had read before it wrote these calls, for the approver to see. */
  exposure: Exposure;
  /** The calls of this run whose results looked like instructions (the latest few). */
  flagged: FlaggedCall[];
}

/** The answer a person gives. This is the value passed to `new Command({ resume })`. */
export const approvalDecisionSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  /** Host user id of the approver (caller-supplied until Step 4.4b, then from a verified token). */
  approverId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
