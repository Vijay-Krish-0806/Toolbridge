import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type QueryFilter } from 'mongoose';
import { Clock } from '../common/clock.js';
import { paginate, type Page } from '../common/query.js';
import { MODEL } from '../domain/models.js';
import type { Shipment } from '../domain/shipment.schema.js';
import type { ListShipmentsQuery } from './shipments.dto.js';

@Injectable()
export class ShipmentsService {
  constructor(
    @InjectModel(MODEL.Shipment.name) private readonly shipments: Model<Shipment>,
    private readonly clock: Clock,
  ) {}

  list(query: ListShipmentsQuery): Promise<Page<Shipment>> {
    const filter: QueryFilter<Shipment> = {};
    if (query.status) filter.status = query.status;
    if (query.carrier) filter.carrier = query.carrier;
    if (query.orderId) filter.orderId = new Types.ObjectId(query.orderId);
    if (query.delayed === true) {
      // Asking for delayed shipments implies in_transit; it overrides a conflicting status filter.
      filter.status = 'in_transit';
      filter.estimatedDeliveryAt = { $lt: this.clock.now() };
    } else if (query.delayed === false) {
      filter.$or = [
        { status: { $ne: 'in_transit' } },
        { estimatedDeliveryAt: { $gte: this.clock.now() } },
      ];
    }
    return paginate(this.shipments, filter, { shippedAt: -1 }, query);
  }

  async getById(id: Types.ObjectId): Promise<Shipment> {
    const shipment = await this.shipments.findById(id).lean().exec();
    if (!shipment) throw new NotFoundException(`No shipment with id ${id.toHexString()}.`);
    return shipment;
  }

  async getByTracking(trackingNumber: string): Promise<Shipment> {
    const shipment = await this.shipments
      .findOne({ trackingNumber: trackingNumber.toUpperCase() })
      .lean()
      .exec();
    if (!shipment)
      throw new NotFoundException(`No shipment with tracking number ${trackingNumber}.`);
    return shipment;
  }
}
