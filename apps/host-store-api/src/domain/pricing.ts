import type { Coupon } from './coupon.schema.js';

/** Discount in integer cents. Shared by the seed and the order API so both price orders the same way. */
export function couponDiscountCents(coupon: Pick<Coupon, 'kind' | 'value'>, subtotalCents: number) {
  return coupon.kind === 'percent'
    ? Math.floor((subtotalCents * coupon.value) / 100)
    : Math.min(coupon.value, subtotalCents);
}
