import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  type AgentRunOutcome,
  continueAgentRun,
  durableRunState,
  type LLMProvider,
  resumeAgentRun,
  startAgentRun,
  STORE_AGENT_SYSTEM_PROMPT,
} from '@toolbridge/agent-core';
import type { MongoSaver } from '@toolbridge/checkpoint-mongo';
import { type Model, Types } from 'mongoose';

import { AGENT_LLM } from '../common/core.module.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type Approval, MODEL, type Run } from '../domain/models.js';
import { EventLog } from '../events/event-log.js';
import { EventSink } from '../events/event-sink.js';
import { CHECKPOINTER } from '../platform.module.js';
import type { RunJob } from '../runs/run-queue.js';
import { RunToolsService } from '../runs/run-tools.js';
import { SpecsService } from '../specs/specs.service.js';

/**
 * Runs ONE leg of a run on a worker (Step 4.4a), and writes how it ended to the run record.
 *
 * A leg can be delivered more than once: BullMQ gives AT-LEAST-ONCE delivery (a worker that dies
 * mid-leg loses its lock, and another worker gets the same job). So a leg never assumes it is the
 * first attempt. It reads where the run stands from its checkpoints and picks the right call:
 * - no checkpoint yet -> start; stopped half-way -> continue from the last checkpoint;
 * - a resume job on a run paused on ITS card -> resume with the decision;
 * - anything else (already paused on a later card, already finished) -> just record that.
 * A write that had already started in the lost attempt is refused by the audit guard, not
 * repeated (see AuditLog.started).
 */
@Injectable()
export class RunExecutor {
  private readonly logger = new Logger(RunExecutor.name);

  constructor(
    @InjectModel(MODEL.Run.name) private readonly runModel: Model<Run>,
    @InjectModel(MODEL.Approval.name) private readonly approvalModel: Model<Approval>,
    @Inject(AGENT_LLM) private readonly llm: LLMProvider,
    @Inject(CHECKPOINTER) private readonly checkpointer: MongoSaver,
    private readonly specs: SpecsService,
    private readonly runTools: RunToolsService,
    private readonly events: EventLog,
  ) {}

  /**
   * Runs the leg until the run pauses or ends, or `signal` aborts it (time limit, cancel). An
   * abort or any other failure throws; the caller (RunWorker) decides between retry and failed.
   */
  async executeLeg(job: RunJob, signal: AbortSignal): Promise<void> {
    const tenantId = new Types.ObjectId(job.tenantId);
    const run = await this.runs(tenantId).findOne({ _id: job.runId });
    if (!run || run.status !== 'running') return; // a stale or duplicate job: nothing to do
    if (run.cancelRequested) {
      await this.end(tenantId, run._id, 'cancelled', 'Cancelled.');
      return;
    }

    const card =
      job.kind === 'resume'
        ? await this.approvals(tenantId).findOne({ _id: new Types.ObjectId(job.approvalId) })
        : null;
    const spec = await this.specs.requireSpec(tenantId, run.specId.toHexString());
    const tools = await this.runTools.build(tenantId, spec, {
      runId: run._id,
      principal: run.principal,
      ...(card && {
        approval: { ...card, approverId: job.kind === 'resume' ? job.decision.approverId : '' },
      }),
    });
    // The leg's progress goes to the event log; every event is written before the leg ends,
    // also when it throws, so a later run_finished never gets a smaller number than its text.
    const sink = new EventSink(this.events, tenantId, run._id);
    const leg = {
      ...tools,
      llm: this.llm,
      checkpointer: this.checkpointer,
      runId: run._id,
      signal,
      onEvent: sink.onEvent,
    };
    try {
      await this.runLeg(job, run, card, leg, sink);
    } finally {
      await sink.flush();
    }
  }

  /** Picks start, continue or resume from the checkpoint, then records the outcome. */
  private async runLeg(
    job: RunJob,
    run: Run,
    card: Approval | null,
    leg: Omit<Parameters<typeof continueAgentRun>[0], never>,
    sink: EventSink,
  ): Promise<void> {
    const state = await durableRunState(this.checkpointer, run._id);
    let outcome: AgentRunOutcome;
    if (state.status === 'new') {
      outcome = await startAgentRun({
        ...leg,
        messages: [
          { role: 'system', content: STORE_AGENT_SYSTEM_PROMPT },
          { role: 'user', content: run.message },
        ],
      });
    } else if (state.status === 'unfinished') {
      outcome = await continueAgentRun(leg);
    } else if (
      job.kind === 'resume' &&
      state.status === 'waiting_for_approval' &&
      card !== null &&
      sameCalls(state.request.calls, card.calls)
    ) {
      outcome = await resumeAgentRun({ ...leg, decision: job.decision });
    } else {
      // Already paused on another card, or already finished: an earlier attempt got this far.
      outcome = state;
    }
    await this.record(run, outcome, sink);
  }

  /**
   * Ends a run that is still `running` with a final status and reason, and writes its last
   * event. Conditional, so it never overwrites (or announces twice) a run that already ended.
   */
  async end(
    tenantId: Types.ObjectId,
    runId: string,
    status: 'failed' | 'cancelled',
    reason: string,
  ): Promise<void> {
    const changed = await this.runs(tenantId).updateOne(
      { _id: runId, status: 'running' },
      { status, error: reason, updatedAt: new Date() },
    );
    if (changed === 0) return;
    this.logger.warn(`Run ${runId} ${status}: ${reason}`);
    await this.events.append(tenantId, runId, {
      type: 'run_finished',
      data: { status, error: reason },
    });
  }

  /**
   * Writes a leg's outcome. A pause creates the approval card HERE, outside the graph (the
   * graph's approval node must stay side-effect free). A retried leg that sees the same pause
   * reuses the open card instead of creating a second one.
   */
  private async record(run: Run, outcome: AgentRunOutcome, sink: EventSink): Promise<void> {
    const { tenantId, _id: runId } = run;
    const now = new Date();
    if (outcome.status === 'waiting_for_approval') {
      const { level, requesterId, calls } = outcome.request;
      const open = await this.approvals(tenantId).findOne({ runId, status: 'pending' });
      const card =
        open ??
        (await this.approvals(tenantId).insertOne({
          runId,
          specId: run.specId,
          status: 'pending',
          level,
          requesterId,
          calls,
          approverId: null,
          reason: null,
          decidedAt: null,
          createdAt: now,
        }));
      const paused = await this.runs(tenantId).updateOne(
        { _id: runId, status: 'running' },
        { status: 'waiting_for_approval', approvalId: card._id, updatedAt: now },
      );
      if (paused > 0) {
        sink.push({
          type: 'approval_required',
          data: {
            approvalId: card._id.toHexString(),
            level: card.level,
            calls: card.calls.map((c) => ({
              callId: c.id,
              tool: c.name,
              arguments: c.arguments,
              level: c.level,
              reason: c.reason,
            })),
          },
        });
      }
      return;
    }
    const { answer, stopReason, usage } = outcome.result;
    const completed = await this.runs(tenantId).updateOne(
      { _id: runId, status: 'running' },
      { status: 'completed', answer, stopReason, usage, updatedAt: now },
    );
    if (completed > 0) {
      sink.push({ type: 'run_finished', data: { status: 'completed', answer, stopReason } });
    }
  }

  private runs(tenantId: Types.ObjectId): TenantScoped<Run> {
    return new TenantScoped(mongooseCollection(this.runModel), tenantId);
  }

  private approvals(tenantId: Types.ObjectId): TenantScoped<Approval> {
    return new TenantScoped(mongooseCollection(this.approvalModel), tenantId);
  }
}

/** True when a paused turn is the one a card was made for (same call ids, in order). */
function sameCalls(a: { id: string }[], b: { id: string }[]): boolean {
  return a.length === b.length && a.every((call, i) => call.id === b[i]?.id);
}
