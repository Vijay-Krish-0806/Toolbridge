import type { Connection } from 'mongoose';
import { auditEventSchema } from './audit-event.schema.js';
import { couponSchema } from './coupon.schema.js';
import { customerSchema } from './customer.schema.js';
import { inventorySchema } from './inventory.schema.js';
import { orderSchema } from './order.schema.js';
import { productSchema } from './product.schema.js';
import { refundSchema } from './refund.schema.js';
import { shipmentSchema } from './shipment.schema.js';
import { userSchema } from './user.schema.js';

/**
 * Model names and schemas in one list, shared by the seed script and the NestJS modules,
 * so both always register the same models under the same names.
 */
export const MODEL = {
  Product: { name: 'Product', schema: productSchema },
  Inventory: { name: 'Inventory', schema: inventorySchema },
  Customer: { name: 'Customer', schema: customerSchema },
  Coupon: { name: 'Coupon', schema: couponSchema },
  Order: { name: 'Order', schema: orderSchema },
  Shipment: { name: 'Shipment', schema: shipmentSchema },
  Refund: { name: 'Refund', schema: refundSchema },
  User: { name: 'User', schema: userSchema },
  AuditEvent: { name: 'AuditEvent', schema: auditEventSchema },
} as const;

/** Registers every model on one connection (not the global mongoose default). Used by the seed. */
export function registerModels(connection: Connection) {
  return {
    users: connection.model('User', userSchema),
    products: connection.model('Product', productSchema),
    inventory: connection.model('Inventory', inventorySchema),
    customers: connection.model('Customer', customerSchema),
    coupons: connection.model('Coupon', couponSchema),
    orders: connection.model('Order', orderSchema),
    shipments: connection.model('Shipment', shipmentSchema),
    refunds: connection.model('Refund', refundSchema),
    auditEvents: connection.model('AuditEvent', auditEventSchema),
  };
}

export type HostModels = ReturnType<typeof registerModels>;
