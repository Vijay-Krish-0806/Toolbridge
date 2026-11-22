import { randomUUID } from 'node:crypto';

import {
  type BeforeApplicationShutdown,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type AgentRunOutcome,
  type ApprovalDecision,
  type LLMProvider,
  type Principal,
  resumeAgentRun,
  startAgentRun,
  STORE_AGENT_SYSTEM_PROMPT,
} from '@toolbridge/agent-core';
import { MongoSaver } from '@toolbridge/checkpoint-mongo';
import type { Connection, Model, Types } from 'mongoose';

import type { AuditContext } from '../audit/audit-log.js';
import { AGENT_LLM } from '../common/core.module.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type Approval, MODEL, type Run, type RunStatus } from '../domain/models.js';
import { SpecsService } from '../specs/specs.service.js';
import { type RunTools, RunToolsService } from './run-tools.js';

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
  createdAt: Date;
  updatedAt: Date;
}

/** A run that is ready to continue: its record and freshly built dependencies. */
export interface PreparedResume {
  tenantId: Types.ObjectId;
  run: Run;
  tools: RunTools;
}

/** Shown on runs that were running when the process stopped. */
const INTERRUPTED = 'The API stopped while this run was running; start it again.';

/**
 * Agent runs, executed IN-PROCESS until Step 4.4a adds a worker (BUILD_PLAN Step 4.3).
 *
 * A run moves through LEGS. A leg is one call to LangGraph (`startAgentRun`, or `resumeAgentRun`
 * after a decision) and lasts until the graph finishes or pauses. Legs run in the background: the
 * HTTP request that starts one returns 202 at once, and the result is written to the run record.
 *
 * Durable state is split in two:
 * - the CHECKPOINT (LangGraph, through MongoSaver): the conversation and where the graph stopped;
 * - the RUN RECORD (ours): status, principal, answer. It is what the API reads, and it holds the
 *   identity that must be supplied again on resume, because LangGraph never saves run context.
 */
@Injectable()
export class RunsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(RunsService.name);
  private readonly checkpointer: MongoSaver;
  /** Legs still executing in this process, so shutdown can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @InjectConnection() connection: Connection,
    @InjectModel(MODEL.Run.name) private readonly runModel: Model<Run>,
    @InjectModel(MODEL.Approval.name) private readonly approvalModel: Model<Approval>,
    @Inject(AGENT_LLM) private readonly llm: LLMProvider,
    private readonly specs: SpecsService,
    private readonly runTools: RunToolsService,
  ) {
    if (!connection.db) throw new Error('MongoDB connection has no database yet.');
    // Checkpoints live in the platform database, in their own two collections (ADR 0030).
    this.checkpointer = new MongoSaver({ db: connection.db });
  }

  /**
   * Startup: create the checkpoint indexes, then mark every run still `running` as failed. Legs
   * run only inside this process, so after a restart nothing can still be executing them. This
   * holds for ONE API instance; Step 4.4a replaces it with a queue that knows which jobs are live.
   * A run waiting for approval is untouched: its checkpoint is safe and it can still be approved.
   * This sweep crosses tenants on purpose (like the key rotation), so it does not use TenantScoped.
   */
  async onModuleInit(): Promise<void> {
    await this.checkpointer.setup();
    const { modifiedCount } = await this.runModel
      .updateMany(
        { status: 'running' },
        { $set: { status: 'failed', error: INTERRUPTED, updatedAt: new Date() } },
      )
      .exec();
    if (modifiedCount > 0) {
      this.logger.warn(`Marked ${String(modifiedCount)} interrupted run(s) as failed.`);
    }
  }

  /** On shutdown, lets running legs finish writing their results before the connection closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Starts a run and returns at once; the graph runs in the background.
   * Before -> after: ("refund ORD-7", support user u1) -> `{ runId: '3f2c…', status: 'running' }`.
   * The tools are built BEFORE the record is saved, so an unknown spec (404) or a spec without a
   * connection (409) is refused in the response, not discovered later.
   */
  async start(
    tenantId: Types.ObjectId,
    input: { specId: string; message: string; principal: Principal },
  ): Promise<{ runId: string; status: RunStatus }> {
    const spec = await this.specs.requireSpec(tenantId, input.specId);
    const runId = randomUUID();
    const tools = await this.runTools.build(tenantId, spec, {
      runId,
      principal: input.principal,
    });
    const now = new Date();
    const run = await this.runs(tenantId).insertOne({
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
      createdAt: now,
      updatedAt: now,
    } as Omit<Run, '_id' | 'tenantId'>);

    this.launch(tenantId, run._id, () =>
      startAgentRun({
        ...tools,
        llm: this.llm,
        checkpointer: this.checkpointer,
        runId: run._id,
        messages: [
          { role: 'system', content: STORE_AGENT_SYSTEM_PROMPT },
          { role: 'user', content: input.message },
        ],
      }),
    );
    return { runId: run._id, status: 'running' };
  }

  /** One run of the tenant, or 404 (also when it belongs to another tenant). */
  async get(tenantId: Types.ObjectId, runId: string): Promise<RunView> {
    return view(await this.require(tenantId, runId));
  }

  /**
   * Step 1 of continuing a run: checks it is waiting and rebuilds its dependencies from the run
   * record (the same principal as at the start). Changes nothing, so the caller can still back
   * out (for example when it loses the race to decide the approval). `approval` is the card
   * being decided, so the audit rows of the calls it lists name it, the requester and approver.
   */
  async prepareResume(
    tenantId: Types.ObjectId,
    runId: string,
    approval: NonNullable<AuditContext['approval']>,
  ): Promise<PreparedResume> {
    const run = await this.require(tenantId, runId);
    if (run.status !== 'waiting_for_approval') {
      throw new ConflictException(`Run ${runId} is not waiting for approval.`);
    }
    const spec = await this.specs.requireSpec(tenantId, run.specId.toHexString());
    const tools = await this.runTools.build(tenantId, spec, {
      runId,
      principal: run.principal,
      approval,
    });
    return { tenantId, run, tools };
  }

  /**
   * Step 2, called only by the request that won the decision: marks the run running and resumes
   * the graph in the background with the decision. LangGraph re-runs the approval node, whose
   * `interrupt()` now returns `decision`.
   */
  async resume(prepared: PreparedResume, decision: ApprovalDecision): Promise<void> {
    const { tenantId, run, tools } = prepared;
    await this.runs(tenantId).updateOne(
      { _id: run._id, status: 'waiting_for_approval' },
      { status: 'running', updatedAt: new Date() },
    );
    this.launch(tenantId, run._id, () =>
      resumeAgentRun({
        ...tools,
        llm: this.llm,
        checkpointer: this.checkpointer,
        runId: run._id,
        decision,
      }),
    );
  }

  /**
   * Runs one leg in the background and records how it ended. Errors never escape: a failed leg
   * marks the run failed (with a short message; details go to the log only).
   */
  private launch(
    tenantId: Types.ObjectId,
    runId: string,
    leg: () => Promise<AgentRunOutcome>,
  ): void {
    const task = leg()
      .then((outcome) => this.record(tenantId, runId, outcome))
      .catch(async (error: unknown) => {
        this.logger.error(
          `Run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.runs(tenantId)
          .updateOne(
            { _id: runId },
            {
              status: 'failed',
              error: 'The run failed; see the platform log.',
              updatedAt: new Date(),
            },
          )
          .catch(() => undefined); // the database itself may be gone (shutdown)
      });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /**
   * Writes a leg's outcome. A pause creates the approval card HERE, outside the graph: the graph's
   * approval node must stay side-effect free, because LangGraph runs it again on resume.
   */
  private async record(
    tenantId: Types.ObjectId,
    runId: string,
    outcome: AgentRunOutcome,
  ): Promise<void> {
    const now = new Date();
    if (outcome.status === 'waiting_for_approval') {
      const { level, requesterId, calls } = outcome.request;
      const approval = await this.approvals(tenantId).insertOne({
        runId,
        status: 'pending',
        level,
        requesterId,
        calls,
        approverId: null,
        reason: null,
        decidedAt: null,
        createdAt: now,
      });
      await this.runs(tenantId).updateOne(
        { _id: runId },
        { status: 'waiting_for_approval', approvalId: approval._id, updatedAt: now },
      );
      return;
    }
    const { answer, stopReason, usage } = outcome.result;
    await this.runs(tenantId).updateOne(
      { _id: runId },
      { status: 'completed', answer, stopReason, usage, updatedAt: now },
    );
  }

  /** The tenant's run, or 404. */
  private async require(tenantId: Types.ObjectId, runId: string): Promise<Run> {
    const run = await this.runs(tenantId).findOne({ _id: runId });
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
function view(run: Run): RunView {
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
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
