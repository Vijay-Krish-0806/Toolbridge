import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PendingCall } from '@toolbridge/agent-core';
import { isValidObjectId, type Model, Types } from 'mongoose';

import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type Approval, type ApprovalStatus, MODEL } from '../domain/models.js';
import type { SessionCaller } from '../sessions/sessions.service.js';
import { RunsService } from './runs.service.js';

/** What callers see about an approval card. */
export interface ApprovalView {
  id: string;
  runId: string;
  status: ApprovalStatus;
  level: Approval['level'];
  requesterId: string;
  /** Every call of the paused turn, with its exact arguments and its own level and reason. */
  calls: PendingCall[];
  approverId: string | null;
  reason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** A decision: the approver (the session's user) and an optional reason. */
export interface DecisionInput {
  approverId: string;
  reason?: string;
}

/**
 * Approval cards: listing them and deciding them. A card is decided EXACTLY ONCE: the change from
 * `pending` to `approved`/`rejected` is one atomic findOneAndUpdate whose filter includes
 * `status: 'pending'`. When two approvers click at the same moment, only one update still
 * matches, so only one request resumes the run; the other gets 409. This is the API's half of
 * "resuming never executes the same write twice"; the graph's own guard is the other half.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectModel(MODEL.Approval.name) private readonly model: Model<Approval>,
    private readonly runs: RunsService,
  ) {}

  /**
   * The cards of one spec of the tenant (the spec the approver's session is for), oldest first,
   * optionally only one status (the inbox uses `pending`).
   */
  async list(
    tenantId: Types.ObjectId,
    specId: string,
    status?: ApprovalStatus,
  ): Promise<ApprovalView[]> {
    const cards = await this.scoped(tenantId).find(
      { specId: new Types.ObjectId(specId), ...(status && { status }) },
      { createdAt: 1 },
    );
    return cards.map(view);
  }

  /**
   * Decides a card and resumes its run in the background. The approver is the session's user
   * (Step 4.4b), so "approver != requester" compares two host user ids from verified tokens.
   * Before -> after: (card for "refunds_request 32893", approve by u2) ->
   * `{ approval: { status: 'approved', approverId: 'u2', ... }, runStatus: 'running' }`.
   * Refused with 403 when the approver requested a high-risk turn themselves; 409 when the card is
   * already decided (also when another request decided it a moment ago). Rejecting your own
   * request is allowed: withdrawing a write is always safe.
   */
  async decide(
    session: SessionCaller,
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ approval: ApprovalView; runStatus: 'running' }> {
    const { tenantId } = session;
    const input: DecisionInput = {
      approverId: session.userId,
      ...(reason !== undefined && { reason }),
    };
    const card = await this.require(tenantId, approvalId);
    // A session is for one spec: a card of another spec is "not found" for it.
    if (card.specId.toHexString() !== session.specId) {
      throw new NotFoundException('Approval not found.');
    }
    if (card.status !== 'pending') throw new ConflictException('This approval is already decided.');
    if (decision === 'approved' && card.level === 'high' && input.approverId === card.requesterId) {
      throw new ForbiddenException(
        'A high-risk action cannot be approved by the person who requested it.',
      );
    }
    // Build the run's dependencies first: if that fails (for example the connection was deleted),
    // the card stays pending instead of being decided for a run that cannot continue.
    const prepared = await this.runs.prepareResume(
      tenantId,
      card.runId,
      { ...card, approverId: input.approverId },
      session.jti,
    );

    const decided = await this.scoped(tenantId).findOneAndUpdate(
      { _id: card._id, status: 'pending' },
      {
        status: decision,
        approverId: input.approverId,
        approverSession: session.jti,
        reason: input.reason ?? null,
        decidedAt: new Date(),
      },
    );
    if (!decided) throw new ConflictException('This approval is already decided.');

    await this.runs.resume(tenantId, prepared, card._id, {
      decision,
      approverId: input.approverId,
      ...(input.reason !== undefined && { reason: input.reason }),
    });
    return { approval: view(decided), runStatus: 'running' };
  }

  /** The tenant's card, or 404 (malformed, unknown and other tenants' ids look the same). */
  private async require(tenantId: Types.ObjectId, approvalId: string): Promise<Approval> {
    const card = isValidObjectId(approvalId)
      ? await this.scoped(tenantId).findOne({ _id: new Types.ObjectId(approvalId) })
      : null;
    if (!card) throw new NotFoundException('Approval not found.');
    return card;
  }

  private scoped(tenantId: Types.ObjectId): TenantScoped<Approval> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }
}

/** The public shape of a card. */
function view(card: Approval): ApprovalView {
  return {
    id: card._id.toHexString(),
    runId: card.runId,
    status: card.status,
    level: card.level,
    requesterId: card.requesterId,
    calls: card.calls,
    approverId: card.approverId,
    reason: card.reason,
    decidedAt: card.decidedAt,
    createdAt: card.createdAt,
  };
}
