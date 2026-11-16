import { Schema, type Types } from 'mongoose';

export const ROLES = ['owner', 'support', 'warehouse'] as const;
export type Role = (typeof ROLES)[number];

/** A staff member who can call the API. Customers do not log in to this API. */
export interface User {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: Role;
  /** Format: scrypt$<salt hex>$<hash hex>. Never the plain password. */
  passwordHash: string;
  createdAt: Date;
}

export const userSchema = new Schema<User>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    role: { type: String, enum: ROLES, required: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'users', versionKey: false },
);
