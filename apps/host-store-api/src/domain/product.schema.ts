import { Schema, type Types } from 'mongoose';

export interface Product {
  _id: Types.ObjectId;
  sku: string;
  name: string;
  category: string;
  description: string;
  /** Price in integer cents. Floats cannot represent most decimal amounts exactly. */
  priceCents: number;
  active: boolean;
  createdAt: Date;
}

export const productSchema = new Schema<Product>(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true, index: true },
    description: { type: String, required: true },
    priceCents: { type: Number, required: true, min: 0 },
    active: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'products', versionKey: false },
);
