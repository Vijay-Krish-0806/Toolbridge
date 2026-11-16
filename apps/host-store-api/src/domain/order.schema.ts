import { Schema, type Types } from 'mongoose';

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

export interface Order {
  _id: Types.ObjectId;
  number: string;
  customerId: Types.ObjectId;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
  /** Untrusted free text. May contain prompt-injection text. */
  notes: string;
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

export const orderSchema = new Schema<Order>(
  {
    number: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
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
    notes: { type: String, default: '' },
    placedAt: { type: Date, required: true },
  },
  { collection: 'orders', versionKey: false },
);

orderSchema.index({ status: 1, placedAt: -1 });
