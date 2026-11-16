import { Types } from 'mongoose';

const ENTITY_CODE = {
  product: 1,
  inventory: 2,
  customer: 3,
  coupon: 4,
  order: 5,
  shipment: 6,
  refund: 7,
} as const;

export type EntityKind = keyof typeof ENTITY_CODE;

/**
 * A deterministic ObjectId. A normal ObjectId mixes the current time with random bytes,
 * so it changes on every run. This one uses the same 12-byte layout but fixed inputs:
 *   4 bytes: the record's own creation time, in seconds (so ids still sort by time)
 *   1 byte:  entity code
 *   7 bytes: counter within that entity
 */
export function seedObjectId(kind: EntityKind, counter: number, createdAt: Date): Types.ObjectId {
  const seconds = Math.floor(createdAt.getTime() / 1000)
    .toString(16)
    .padStart(8, '0');
  const code = ENTITY_CODE[kind].toString(16).padStart(2, '0');
  return new Types.ObjectId(seconds + code + counter.toString(16).padStart(14, '0'));
}
