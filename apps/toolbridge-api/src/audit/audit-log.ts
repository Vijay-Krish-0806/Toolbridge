import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  type AuditedCall,
  type AuditOutcome,
  type ToolAuditor,
  WriteAlreadyStartedError,
} from '@toolbridge/agent-core';
import { type Model, Types } from 'mongoose';

import { mongooseCollection } from '../common/mongoose-collection.js';
import { type Filter, TenantScoped } from '../common/tenant-scoped.js';
import {
  type Approval,
  type AuditActor,
  type AuditEntry,
  type CredentialMode,
  MODEL,
} from '../domain/models.js';

/** Who and why, known to the platform for one run leg or one direct call. */
export interface AuditContext {
  runId: string | null;
  actor: AuditActor;
  credentialMode: CredentialMode;
  /** The spec's policy version in force (null = no policy, deny-all; or a direct call). */
  policyVersion: number | null;
  /**
   * The approval decided for this leg. It is stamped only on the calls its card lists (matched
   * by call id), so reads the model makes later in the same leg are not shown as approved.
   */
  approval?: Pick<Approval, '_id' | 'level' | 'requesterId' | 'calls'> & { approverId: string };
}

/** Filters of the query API; all optional, combined with AND. */
export interface AuditQuery {
  runId?: string;
  toolName?: string;
  userId?: string;
  approvalId?: string;
  safety?: 'read' | 'write';
  from?: Date;
  to?: Date;
  limit: number;
}

/** What callers see about an audit row. */
export interface AuditView extends Omit<AuditEntry, '_id' | 'tenantId' | 'approval'> {
  id: string;
  approval: (Omit<NonNullable<AuditEntry['approval']>, 'id'> & { id: string }) | null;
}

/**
 * The audit log (Step 4.10, ADR 0032). APPEND-ONLY by construction: this class is the only code
 * that touches the collection, and it can only insert rows and read them. There is no update or
 * delete here, so no code path can change history. (The database role is not insert-only yet:
 * local development runs as the root user. See the ADR.)
 */
@Injectable()
export class AuditLog {
  private readonly logger = new Logger(AuditLog.name);

  constructor(@InjectModel(MODEL.AuditEntry.name) private readonly model: Model<AuditEntry>) {}

  /**
   * The executor's audit port for one leg or call, writing this tenant's rows.
   * `started` lets an error escape: the executor then refuses the write (fail closed).
   * `finished` never throws: the call already happened; a lost row is logged loudly instead.
   */
  auditorFor(tenantId: Types.ObjectId, context: AuditContext): ToolAuditor {
    const approvedCalls = new Set(context.approval?.calls.map((c) => c.id) ?? []);
    const row = (call: AuditedCall): Omit<AuditEntry, '_id' | 'tenantId' | 'phase' | 'at'> => ({
      runId: context.runId,
      callId: call.callId,
      toolName: call.toolName,
      safety: call.safety,
      actor: context.actor,
      credentialMode: context.credentialMode,
      argsHash: call.argsHash,
      status: null,
      durationMs: null,
      policyVersion: context.policyVersion,
      approval:
        context.approval && approvedCalls.has(call.callId)
          ? {
              id: context.approval._id,
              level: context.approval.level,
              requesterId: context.approval.requesterId,
              approverId: context.approval.approverId,
            }
          : null,
    });
    return {
      started: async (call) => {
        try {
          await this.append(tenantId, { ...row(call), phase: 'started', at: new Date() });
        } catch (error) {
          // The unique index on started rows: this exact write already started in an earlier
          // attempt of the run (the worker died or the leg was retried). Never run it twice.
          if (error instanceof Error && 'code' in error && error.code === 11000) {
            throw new WriteAlreadyStartedError(`Call ${call.callId} already started in this run.`);
          }
          throw error;
        }
      },
      finished: async (call: AuditedCall, outcome: AuditOutcome) => {
        try {
          await this.append(tenantId, {
            ...row(call),
            phase: 'finished',
            at: new Date(),
            status: outcome.status,
            durationMs: outcome.durationMs,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Audit row lost for call ${call.callId} (${call.toolName}, ${outcome.status}): ${message}`,
          );
        }
      },
    };
  }

  /**
   * The tenant's rows matching `query`, newest first.
   * Before -> after: `{ safety: 'write', runId: '3f2c…', limit: 50 }` -> the write's `finished`
   * and `started` rows, each naming the user, role, approval, requester and approver.
   */
  async query(tenantId: Types.ObjectId, query: AuditQuery): Promise<AuditView[]> {
    const filter: Filter = {};
    if (query.runId) filter.runId = query.runId;
    if (query.toolName) filter.toolName = query.toolName;
    if (query.userId) filter['actor.userId'] = query.userId;
    if (query.approvalId) filter['approval.id'] = new Types.ObjectId(query.approvalId);
    if (query.safety) filter.safety = query.safety;
    if (query.from ?? query.to) {
      filter.at = {
        ...(query.from && { $gte: query.from }),
        ...(query.to && { $lte: query.to }),
      };
    }
    const rows = await this.scoped(tenantId).find(filter, { at: -1, _id: -1 }, query.limit);
    return rows.map(view);
  }

  /** Inserts one row for the tenant. The only write this class can make. */
  private async append(
    tenantId: Types.ObjectId,
    entry: Omit<AuditEntry, '_id' | 'tenantId'>,
  ): Promise<void> {
    await this.scoped(tenantId).insertOne(entry);
  }

  private scoped(tenantId: Types.ObjectId): TenantScoped<AuditEntry> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }
}

/** The public shape of a row. */
function view(row: AuditEntry): AuditView {
  return {
    id: row._id.toHexString(),
    at: row.at,
    phase: row.phase,
    runId: row.runId,
    callId: row.callId,
    toolName: row.toolName,
    safety: row.safety,
    actor: row.actor,
    credentialMode: row.credentialMode,
    argsHash: row.argsHash,
    status: row.status,
    durationMs: row.durationMs,
    policyVersion: row.policyVersion,
    approval: row.approval ? { ...row.approval, id: row.approval.id.toHexString() } : null,
  };
}
