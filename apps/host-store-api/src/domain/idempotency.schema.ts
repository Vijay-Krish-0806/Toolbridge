import { Schema } from 'mongoose';

/**
 * One idempotency key's record (Step 4.5): the first request with a key does the work, and every
 * repeat gets the stored answer instead of doing it again. Keyed by sha256(user id + key), so two
 * users can never collide on, or read, each other's keys.
 */
export interface IdempotencyRecord {
  _id: string;
  userId: string;
  /** sha256 of method, path and body: the same key with a different request is refused. */
  requestHash: string;
  state: 'in_progress' | 'completed';
  statusCode: number | null;
  body: unknown;
  createdAt: Date;
  /** REAL time (not the API's frozen demo clock): MongoDB's TTL index deletes by the real clock. */
  expiresAt: Date;
}

export const idempotencySchema = new Schema<IdempotencyRecord>({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  requestHash: { type: String, required: true },
  state: { type: String, enum: ['in_progress', 'completed'], required: true },
  statusCode: { type: Number, default: null },
  body: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
// Keys live 24 hours, then MongoDB deletes them.
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
