import { Schema, type Types } from 'mongoose';

export const CARRIERS = ['ups', 'fedex', 'dhl', 'usps'] as const;
export type Carrier = (typeof CARRIERS)[number];

export const SHIPMENT_STATUSES = ['in_transit', 'delivered'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * There is no stored "delayed" flag. A shipment is delayed when it is still in transit
 * after its estimated delivery date, so callers must filter by date, as in a real API.
 */
export interface Shipment {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  carrier: Carrier;
  trackingNumber: string;
  status: ShipmentStatus;
  shippedAt: Date;
  estimatedDeliveryAt: Date;
  deliveredAt: Date | null;
}

export const shipmentSchema = new Schema<Shipment>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    carrier: { type: String, enum: CARRIERS, required: true },
    trackingNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: SHIPMENT_STATUSES, required: true },
    shippedAt: { type: Date, required: true },
    estimatedDeliveryAt: { type: Date, required: true },
    deliveredAt: { type: Date, default: null },
  },
  { collection: 'shipments', versionKey: false },
);

shipmentSchema.index({ status: 1, estimatedDeliveryAt: 1 });
