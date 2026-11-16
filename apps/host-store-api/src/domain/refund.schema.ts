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

/** A separate collection, not embedded in orders: refunds have their own lifecycle and audit trail. */
export interface Refund {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  amountCents: number;
  reason: RefundReason;
  status: RefundStatus;
  requestedAt: Date;
  processedAt: Date | null;
}

export const refundSchema = new Schema<Refund>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true },
    requestedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
  },
  { collection: 'refunds', versionKey: false },
);

refundSchema.index({ status: 1, requestedAt: -1 });
