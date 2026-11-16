import { Schema, type Types } from 'mongoose';

export const COUPON_KINDS = ['percent', 'fixed'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export interface Coupon {
  _id: Types.ObjectId;
  code: string;
  kind: CouponKind;
  /** Percent off (1 to 100) for 'percent', or integer cents off for 'fixed'. */
  value: number;
  active: boolean;
  expiresAt: Date;
  /** null means unlimited. */
  maxUses: number | null;
  timesUsed: number;
  createdAt: Date;
}

export const couponSchema = new Schema<Coupon>(
  {
    code: { type: String, required: true, unique: true },
    kind: { type: String, enum: COUPON_KINDS, required: true },
    value: { type: Number, required: true, min: 1 },
    active: { type: Boolean, required: true },
    expiresAt: { type: Date, required: true },
    maxUses: { type: Number, default: null, min: 1 },
    timesUsed: { type: Number, required: true, min: 0 },
    createdAt: { type: Date, required: true },
  },
  { collection: 'coupons', versionKey: false },
);
