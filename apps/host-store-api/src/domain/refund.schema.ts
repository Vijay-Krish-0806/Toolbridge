import { Schema, type Types } from 'mongoose';

export const REFUND_STATUSES = ['pending', 'completed', 'rejected'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_REASONS = [
  'damaged',
  'not_as_described',
  'late_delivery',
  'changed_mind',
  'other',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * A separate collection, not embedded in orders: refunds have their own lifecycle and audit trail.
 * Two steps: support or owner requests (pending), then only the owner approves or rejects.
 */
export interface Refund {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  amountCents: number;
  reason: RefundReason;
  status: RefundStatus;
  requestedAt: Date;
  /** Staff user who requested it. null for seeded history. */
  requestedBy: Types.ObjectId | null;
  processedAt: Date | null;
  processedBy: Types.ObjectId | null;
  /** Owner's note when approving or rejecting. */
  decisionNote: string | null;
}

export const refundSchema = new Schema<Refund>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true },
    requestedAt: { type: Date, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decisionNote: { type: String, default: null },
  },
  { collection: 'refunds', versionKey: false },
);

refundSchema.index({ status: 1, requestedAt: -1 });
