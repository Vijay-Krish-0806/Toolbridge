import { Schema, type Types } from 'mongoose';
import { WAREHOUSES, type Warehouse } from './inventory.schema.js';

export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * A line item copies the product's name and price at purchase time (a snapshot).
 * Later price changes must not rewrite what the customer actually paid.
 */
export interface OrderItem {
  productId: Types.ObjectId;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface Cancellation {
  /** Staff user who cancelled. null for seeded history. */
  by: Types.ObjectId | null;
  reason: string;
  at: Date;
}

export interface Order {
  _id: Types.ObjectId;
  number: string;
  customerId: Types.ObjectId;
  status: OrderStatus;
  /** The warehouse that reserves and ships this order's stock. */
  warehouse: Warehouse;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
  /**
   * Sum of pending and completed refunds, in cents. Kept on the order so a new refund can be
   * checked and counted in one atomic update: refundCommittedCents + amount <= totalCents.
   */
  refundCommittedCents: number;
  /** Untrusted free text. May contain prompt-injection text. */
  notes: string;
  cancellation: Cancellation | null;
  placedAt: Date;
}

const orderItemSchema = new Schema<OrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    unitPriceCents: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const cancellationSchema = new Schema<Cancellation>(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

export const orderSchema = new Schema<Order>(
  {
    number: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    warehouse: { type: String, enum: WAREHOUSES, required: true },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items: OrderItem[]) => items.length > 0,
        message: 'an order needs at least one item',
      },
    },
    subtotalCents: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, required: true, min: 0 },
    totalCents: { type: Number, required: true, min: 0 },
    couponCode: { type: String, default: null },
    refundCommittedCents: { type: Number, required: true, min: 0, default: 0 },
    notes: { type: String, default: '' },
    cancellation: { type: cancellationSchema, default: null },
    placedAt: { type: Date, required: true },
  },
  { collection: 'orders', versionKey: false },
);

orderSchema.index({ status: 1, placedAt: -1 });
