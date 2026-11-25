import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type {
  ConversationHistory,
  Exposure,
  Principal,
  SummaryUpdate,
} from '@toolbridge/agent-core';
import type { Model, Types } from 'mongoose';

import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type Conversation, type CredentialMode, MODEL, type Run } from '../domain/models.js';

/** Most unsummarized turns read for one run: a backstop if summaries keep failing. */
const MAX_TURNS = 50;

/** Stands for an answer that a limit cut short, so every turn has both sides. */
const NO_ANSWER = '(No answer: this request stopped early.)';

/** Who a conversation belongs to. Every field must match, or it does not exist for the caller. */
export interface ConversationOwner {
  specId: Types.ObjectId;
  principal: Principal;
  credentialMode: CredentialMode;
}

/**
 * Conversations (Step 4.7, ADR 0044): what lets a run know about the runs before it.
 *
 * There is no separate transcript. A conversation's turns ARE its run records (message and
 * answer), so there is one copy of the truth; this record adds who owns it and the summary of its
 * oldest turns. It belongs to one tenant, spec, user, ROLE and credential mode: after a user is
 * demoted, or the tenant switches mode, answers fetched with the wider access are not replayed.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(MODEL.Conversation.name) private readonly model: Model<Conversation>,
    @InjectModel(MODEL.Run.name) private readonly runModel: Model<Run>,
  ) {}

  /**
   * The conversation a new run belongs to: a new one without `id`; otherwise the caller's own, or
   * 404 (the same 404 whether it does not exist or belongs to someone else).
   * Before -> after: (owner, undefined) -> a new id; (owner, 'c-1' of another user) -> 404.
   */
  async resolve(tenantId: Types.ObjectId, owner: ConversationOwner, id?: string): Promise<string> {
    const owned = {
      specId: owner.specId,
      userId: owner.principal.userId,
      role: owner.principal.role,
      credentialMode: owner.credentialMode,
    };
    if (id !== undefined) {
      const found = await this.conversations(tenantId).findOne({ _id: id, ...owned });
      if (!found) throw new NotFoundException('Conversation not found.');
      return id;
    }
    const now = new Date();
    const created = await this.conversations(tenantId).insertOne({
      _id: randomUUID(),
      ...owned,
      summary: '',
      summarizedThrough: null,
      exposure: 'none',
      createdAt: now,
      updatedAt: now,
    } as Omit<Conversation, '_id' | 'tenantId'>);
    return created._id;
  }

  /**
   * What a run starts with: the saved summary and the completed turns after it, oldest first.
   * Failed and cancelled runs are left out. A run record holds no tool calls or results, so
   * neither does the history. One run at a time per conversation (a unique index), so the runs
   * created before this one are exactly the earlier turns.
   */
  async historyFor(tenantId: Types.ObjectId, run: Run): Promise<ConversationHistory | undefined> {
    if (!run.conversationId) return undefined; // a run from before 4.7
    const conversation = await this.conversations(tenantId).findOne({ _id: run.conversationId });
    if (!conversation) return undefined;
    const runs = await this.runs(tenantId).find(
      {
        conversationId: conversation._id,
        status: 'completed',
        createdAt: {
          $lt: run.createdAt,
          ...(conversation.summarizedThrough && { $gt: conversation.summarizedThrough }),
        },
      },
      { createdAt: -1 },
      MAX_TURNS,
    );
    return {
      // Step 4.9: earlier answers and the summary were written after what those runs had read.
      exposure: conversation.exposure ?? 'seen',
      summary: conversation.summary,
      turns: runs.toReversed().map((earlier) => ({
        id: earlier._id,
        user: earlier.message,
        answer: earlier.answer ? earlier.answer : NO_ANSWER,
      })),
    };
  }

  /**
   * Saves a run's new summary and how far it reaches, as the creation time of the last run it
   * covers. Writing it twice (a retried leg) changes nothing.
   */
  async saveSummary(tenantId: Types.ObjectId, run: Run, update: SummaryUpdate): Promise<void> {
    if (!run.conversationId) return;
    const through = await this.runs(tenantId).findOne({
      _id: update.throughTurnId,
      conversationId: run.conversationId,
    });
    if (!through) return;
    await this.conversations(tenantId).updateOne(
      { _id: run.conversationId },
      { summary: update.summary, summarizedThrough: through.createdAt, updatedAt: new Date() },
    );
  }

  /**
   * Saves what the agent had read by the end of a run (Step 4.9). A run starts from its
   * conversation's exposure and it only goes up, so the run's value is the conversation's new one.
   */
  async saveExposure(tenantId: Types.ObjectId, run: Run, exposure: Exposure): Promise<void> {
    if (!run.conversationId) return;
    await this.conversations(tenantId).updateOne({ _id: run.conversationId }, { exposure });
  }

  private conversations(tenantId: Types.ObjectId): TenantScoped<Conversation> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }

  private runs(tenantId: Types.ObjectId): TenantScoped<Run> {
    return new TenantScoped(mongooseCollection(this.runModel), tenantId);
  }
}
