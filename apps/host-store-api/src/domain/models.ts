import type { Connection } from 'mongoose';
import { couponSchema } from './coupon.schema.js';
import { customerSchema } from './customer.schema.js';
import { inventorySchema } from './inventory.schema.js';
import { orderSchema } from './order.schema.js';
import { productSchema } from './product.schema.js';
import { refundSchema } from './refund.schema.js';
import { shipmentSchema } from './shipment.schema.js';

/** Registers every model on one connection (not the global mongoose default), so tests can use their own. */
export function registerModels(connection: Connection) {
  return {
    products: connection.model('Product', productSchema),
    inventory: connection.model('Inventory', inventorySchema),
    customers: connection.model('Customer', customerSchema),
    coupons: connection.model('Coupon', couponSchema),
    orders: connection.model('Order', orderSchema),
    shipments: connection.model('Shipment', shipmentSchema),
    refunds: connection.model('Refund', refundSchema),
  };
}

export type HostModels = ReturnType<typeof registerModels>;
