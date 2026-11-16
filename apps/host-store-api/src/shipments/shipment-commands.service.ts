import { ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types, type ClientSession, type Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import { notFoundOrConflict } from '../common/errors.js';
import type { Inventory } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { Order } from '../domain/order.schema.js';
import type { Carrier, Shipment } from '../domain/shipment.schema.js';

const TRANSIT_DAYS = 5;
const DAY_MS = 86_400_000;

@Injectable()
export class ShipmentCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Shipment.name) private readonly shipments: Model<Shipment>,
    @InjectModel(MODEL.Order.name) private readonly orders: Model<Order>,
    @InjectModel(MODEL.Inventory.name) private readonly inventory: Model<Inventory>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Ships a paid order: the order becomes shipped, and its reserved units leave the warehouse. */
  create(orderId: string, carrier: Carrier, actor: AuthUser): Promise<Shipment> {
    return this.connection.transaction(async (session) => {
      const id = new Types.ObjectId(orderId);
      const order = await this.orders
        .findOneAndUpdate(
          { _id: id, status: 'paid' },
          { $set: { status: 'shipped' } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!order) {
        const found = await this.orders.findById(id, { status: 1 }).session(session).lean().exec();
        throw notFoundOrConflict(found, `Order ${orderId}`, 'Only paid orders can be shipped.');
      }

      for (const item of order.items) {
        const result = await this.inventory
          .updateOne(
            {
              productId: item.productId,
              warehouse: order.warehouse,
              onHand: { $gte: item.quantity },
              reserved: { $gte: item.quantity },
            },
            { $inc: { onHand: -item.quantity, reserved: -item.quantity } },
            { session },
          )
          .exec();
        if (result.modifiedCount === 0) {
          throw new ConflictException(`Stock record for ${item.sku} does not cover this shipment.`);
        }
      }

      const now = this.clock.now();
      const [shipment] = await this.shipments.create(
        [
          {
            orderId: id,
            carrier,
            trackingNumber: await this.nextTrackingNumber(session),
            status: 'in_transit',
            shippedAt: now,
            estimatedDeliveryAt: new Date(now.getTime() + TRANSIT_DAYS * DAY_MS),
            deliveredAt: null,
          },
        ],
        { session },
      );
      if (!shipment) throw new Error('Shipment insert returned nothing');
      await this.audit.record(
        actor,
        {
          action: 'shipment.create',
          targetType: 'order',
          targetId: orderId,
          details: { trackingNumber: shipment.trackingNumber, carrier },
        },
        session,
      );
      return shipment.toObject();
    });
  }

  deliver(id: Types.ObjectId, actor: AuthUser): Promise<Shipment> {
    return this.connection.transaction(async (session) => {
      const shipment = await this.shipments
        .findOneAndUpdate(
          { _id: id, status: 'in_transit' },
          { $set: { status: 'delivered', deliveredAt: this.clock.now() } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!shipment) {
        const found = await this.shipments
          .findById(id, { status: 1 })
          .session(session)
          .lean()
          .exec();
        throw notFoundOrConflict(
          found,
          `Shipment ${id.toHexString()}`,
          'Only in-transit shipments can be delivered.',
        );
      }
      await this.orders
        .updateOne(
          { _id: shipment.orderId, status: 'shipped' },
          { $set: { status: 'delivered' } },
          { session },
        )
        .exec();
      await this.audit.record(
        actor,
        { action: 'shipment.deliver', targetType: 'shipment', targetId: id.toHexString() },
        session,
      );
      return shipment;
    });
  }

  private async nextTrackingNumber(session: ClientSession): Promise<string> {
    const last = await this.shipments
      .findOne({}, { trackingNumber: 1 })
      .sort({ trackingNumber: -1 })
      .session(session)
      .lean()
      .exec();
    const lastNumber = last ? Number(last.trackingNumber.replace('TRK', '')) : 0;
    return `TRK${String(lastNumber + 1).padStart(8, '0')}`;
  }
}
