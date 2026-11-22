import { randomUUID } from 'node:crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ApprovalDecision, Principal } from '@toolbridge/agent-core';
import type { Model, Types } from 'mongoose';

import type { AuditContext } from '../audit/audit-log.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type Approval, MODEL, type Run, type RunStatus } from '../domain/models.js';
import { EventLog } from '../events/event-log.js';
import { SpecsService } from '../specs/specs.service.js';
import { RunQueue } from './run-queue.js';
import { RunToolsService } from './run-tools.js';

/** What callers see about a run. */
export interface RunView {
  id: string;
  specId: string;
  status: RunStatus;
  principal: Principal;
  credentialMode: Run['credentialMode'];
  approvalId: string | null;
  answer: string | null;
  stopReason: string | null;
  usage: Run['usage'];
  error: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Agent runs, API side (Step 4.4a). The API never runs a leg itself any more: it saves the run
 * record and QUEUES the leg; a worker process (apps/toolbridge-worker) picks it up. So a run
 * survives the browser tab closing and the API restarting, and a dead worker's leg is continued
 * by another worker.
 *
 * Durable state is split in two:
 * - the CHECKPOINT (LangGraph, through MongoSaver): the conversation and where the graph stopped;
 * - the RUN RECORD (ours): status, principal, answer. It is what the API reads, and it holds the
 *   identity that must be supplied again on every leg, because LangGraph never saves run context.
 */
@Injectable()
export class RunsService {
  constructor(
    @InjectModel(MODEL.Run.name) private readonly runModel: Model<Run>,
    @InjectModel(MODEL.Approval.name) private readonly approvalModel: Model<Approval>,
    private readonly specs: SpecsService,
    private readonly runTools: RunToolsService,
    private readonly queue: RunQueue,
    private readonly events: EventLog,
  ) {}

  /**
   * Saves a run and queues its first leg; returns at once.
   * Before -> after: ("refund ORD-7", support user u1) -> `{ runId: '3f2c…', status: 'running' }`.
   * The tools are built once here only as a CHECK, so an unknown spec (404) or a spec without a
   * connection (409) is refused in the response instead of failing later on a worker.
   */
  async start(
    tenantId: Types.ObjectId,
    input: { specId: string; message: string; principal: Principal },
  ): Promise<{ runId: string; status: RunStatus }> {
    const spec = await this.specs.requireSpec(tenantId, input.specId);
    const runId = randomUUID();
    await this.runTools.build(tenantId, spec, { runId, principal: input.principal });
    const now = new Date();
    await this.runs(tenantId).insertOne({
      _id: runId,
      specId: spec._id,
      message: input.message,
      principal: { userId: input.principal.userId, role: input.principal.role },
      credentialMode: 'service',
      status: 'running',
      approvalId: null,
      answer: null,
      stopReason: null,
      usage: null,
      error: null,
      cancelRequested: false,
      eventSeq: 0,
      createdAt: now,
      updatedAt: now,
    } as Omit<Run, '_id' | 'tenantId'>);
    await this.queue.start(tenantId.toHexString(), runId);
    return { runId, status: 'running' };
  }

  /** One run of `userId` in the tenant, or 404 (also another user's or another tenant's run). */
  async get(tenantId: Types.ObjectId, runId: string, userId: string): Promise<RunView> {
    return view(await this.require(tenantId, runId, userId));
  }

  /**
   * Step 1 of continuing a run after a decision: checks it is waiting, and that its tools can
   * still be built (for example the connection was not deleted meanwhile). Changes nothing, so
   * the caller can still back out (when it loses the race to decide the card).
   */
  async prepareResume(
    tenantId: Types.ObjectId,
    runId: string,
    approval: NonNullable<AuditContext['approval']>,
  ): Promise<Run> {
    const run = await this.require(tenantId, runId);
    if (run.status !== 'waiting_for_approval') {
      throw new ConflictException(`Run ${runId} is not waiting for approval.`);
    }
    const spec = await this.specs.requireSpec(tenantId, run.specId.toHexString());
    await this.runTools.build(tenantId, spec, { runId, principal: run.principal, approval });
    return run;
  }

  /**
   * Step 2, called only by the request that won the decision: marks the run running and queues
   * the resume leg. The worker resumes the graph; LangGraph re-runs the approval node, whose
   * `interrupt()` then returns `decision`.
   */
  async resume(
    tenantId: Types.ObjectId,
    run: Run,
    approvalId: Types.ObjectId,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.runs(tenantId).updateOne(
      { _id: run._id, status: 'waiting_for_approval' },
      { status: 'running', updatedAt: new Date() },
    );
    await this.queue.resume({
      kind: 'resume',
      tenantId: tenantId.toHexString(),
      runId: run._id,
      approvalId: approvalId.toHexString(),
      decision,
    });
  }

  /**
   * Cancels a run.
   * - Waiting for approval: nothing is executing, so it is cancelled at once and its card
   *   closed (it can no longer be approved).
   * - Running: the request is recorded and broadcast; the worker running the leg aborts it and
   *   marks the run cancelled (a queued leg sees the flag when it starts).
   * - Already ended: 409.
   */
  async cancel(tenantId: Types.ObjectId, runId: string, userId: string): Promise<RunView> {
    const run = await this.require(tenantId, runId, userId);
    const now = new Date();
    if (run.status === 'waiting_for_approval') {
      const cancelled = await this.runs(tenantId).findOneAndUpdate(
        { _id: runId, status: 'waiting_for_approval' },
        { status: 'cancelled', cancelRequested: true, error: 'Cancelled.', updatedAt: now },
      );
      if (cancelled) {
        await this.approvals(tenantId).updateOne(
          { runId, status: 'pending' },
          { status: 'cancelled', decidedAt: now },
        );
        await this.events.append(tenantId, runId, {
          type: 'run_finished',
          data: { status: 'cancelled', error: 'Cancelled.' },
        });
        return view(cancelled);
      }
    }
    const flagged = await this.runs(tenantId).findOneAndUpdate(
      { _id: runId, status: 'running' },
      { cancelRequested: true, updatedAt: now },
    );
    if (!flagged) throw new ConflictException(`Run ${runId} has already ended.`);
    await this.queue.cancel(runId);
    return view(flagged);
  }

  /** The tenant's run, or 404. */
  /**
   * The tenant's run, or 404. With `userId`, only that user's run: a host user sees their own
   * runs, never a colleague's (the same 404 whether it exists or not).
   */
  private async require(tenantId: Types.ObjectId, runId: string, userId?: string): Promise<Run> {
    const run = await this.runs(tenantId).findOne({
      _id: runId,
      ...(userId !== undefined && { 'principal.userId': userId }),
    });
    if (!run) throw new NotFoundException('Run not found.');
    return run;
  }

  private runs(tenantId: Types.ObjectId): TenantScoped<Run> {
    return new TenantScoped(mongooseCollection(this.runModel), tenantId);
  }

  private approvals(tenantId: Types.ObjectId): TenantScoped<Approval> {
    return new TenantScoped(mongooseCollection(this.approvalModel), tenantId);
  }
}

/** The public shape of a run record. */
export function view(run: Run): RunView {
  return {
    id: run._id,
    specId: run.specId.toHexString(),
    status: run.status,
    principal: run.principal,
    credentialMode: run.credentialMode,
    approvalId: run.approvalId?.toHexString() ?? null,
    answer: run.answer,
    stopReason: run.stopReason,
    usage: run.usage,
    error: run.error,
    cancelRequested: run.cancelRequested,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
