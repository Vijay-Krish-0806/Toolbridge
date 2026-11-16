import { Schema, type Types } from 'mongoose';

export const WAREHOUSES = ['east', 'west'] as const;
export type Warehouse = (typeof WAREHOUSES)[number];

/** Stock for one product in one warehouse. Kept apart from products so warehouse staff update it alone. */
export interface Inventory {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  warehouse: Warehouse;
  onHand: number;
  /** Units held for unshipped orders. Available stock is onHand - reserved. */
  reserved: number;
  reorderLevel: number;
}

export const inventorySchema = new Schema<Inventory>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouse: { type: String, enum: WAREHOUSES, required: true },
    onHand: { type: Number, required: true, min: 0 },
    reserved: { type: Number, required: true, min: 0 },
    reorderLevel: { type: Number, required: true, min: 0 },
  },
  { collection: 'inventory', versionKey: false },
);

inventorySchema.index({ productId: 1, warehouse: 1 }, { unique: true });
