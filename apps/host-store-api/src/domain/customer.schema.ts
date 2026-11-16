import { Schema, type Types } from 'mongoose';

export const CUSTOMER_TIERS = ['standard', 'gold'] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

export interface Address {
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Customer {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  tier: CustomerTier;
  address: Address;
  /** Free text written by staff or the customer. Untrusted: may contain prompt-injection text. */
  notes: string;
  createdAt: Date;
}

const addressSchema = new Schema<Address>(
  {
    line1: { type: String, required: true },
    city: { type: String, required: true },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false },
);

export const customerSchema = new Schema<Customer>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    tier: { type: String, enum: CUSTOMER_TIERS, required: true },
    address: { type: addressSchema, required: true },
    notes: { type: String, default: '' },
    createdAt: { type: Date, required: true },
  },
  { collection: 'customers', versionKey: false },
);
