import { Schema, type Types } from 'mongoose';
import { ROLES, type Role } from './user.schema.js';

/**
 * One record per successful write: who did what to which record. Written in the same
 * transaction as the change, so a change and its audit record are never out of step.
 */
export interface AuditEvent {
  _id: Types.ObjectId;
  at: Date;
  actorId: Types.ObjectId;
  actorRole: Role;
  /** For example "order.cancel" or "inventory.adjust". */
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

export const auditEventSchema = new Schema<AuditEvent>(
  {
    at: { type: Date, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, enum: ROLES, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'audit_events', versionKey: false },
);

auditEventSchema.index({ targetType: 1, targetId: 1, at: -1 });
