import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type ClientSession } from 'mongoose';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import type { AuditEvent } from '../domain/audit-event.schema.js';
import { MODEL } from '../domain/models.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(MODEL.AuditEvent.name) private readonly events: Model<AuditEvent>,
    private readonly clock: Clock,
  ) {}

  /** Pass the transaction's session so the audit record commits or rolls back with the change. */
  async record(actor: AuthUser, entry: AuditEntry, session?: ClientSession): Promise<void> {
    await this.events.create(
      [
        {
          at: this.clock.now(),
          actorId: new Types.ObjectId(actor.id),
          actorRole: actor.role,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          details: entry.details ?? {},
        },
      ],
      { session },
    );
  }
}
