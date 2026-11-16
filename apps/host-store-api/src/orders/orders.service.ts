import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type QueryFilter } from 'mongoose';
import { Clock } from '../common/clock.js';
import { dateRange, paginate, type Page, type PageQuery } from '../common/query.js';
import { MODEL } from '../domain/models.js';
import type { Order } from '../domain/order.schema.js';
import type { Shipment } from '../domain/shipment.schema.js';
import type { ListOrdersQuery } from './orders.dto.js';

const DAY_MS = 86_400_000;

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(MODEL.Order.name) private readonly orders: Model<Order>,
    @InjectModel(MODEL.Shipment.name) private readonly shipments: Model<Shipment>,
    private readonly clock: Clock,
  ) {}

  list(query: ListOrdersQuery): Promise<Page<Order>> {
    const filter: QueryFilter<Order> = {};
    if (query.status) filter.status = query.status;
    if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
    if (query.couponCode) filter.couponCode = query.couponCode.toUpperCase();
    if (query.minTotalCents !== undefined) filter.totalCents = { $gte: query.minTotalCents };
    const placed = dateRange(query.from, query.to);
    if (placed) filter.placedAt = placed;
    return paginate(this.orders, filter, { placedAt: -1 }, query);
  }

  forCustomer(customerId: Types.ObjectId, query: PageQuery): Promise<Page<Order>> {
    return paginate(this.orders, { customerId }, { placedAt: -1 }, query);
  }

  async getById(id: Types.ObjectId): Promise<Order> {
    const order = await this.orders.findById(id).lean().exec();
    if (!order) throw new NotFoundException(`No order with id ${id.toHexString()}.`);
    return order;
  }

  async getByNumber(number: string): Promise<Order> {
    const order = await this.orders.findOne({ number: number.toUpperCase() }).lean().exec();
    if (!order) throw new NotFoundException(`No order with number ${number}.`);
    return order;
  }

  /** Delayed = shipment still in transit after its estimated delivery date, most overdue first. */
  async delayed(query: PageQuery) {
    const now = this.clock.now();
    const page = await paginate(
      this.shipments,
      { status: 'in_transit', estimatedDeliveryAt: { $lt: now } },
      { estimatedDeliveryAt: 1 },
      query,
    );
    const orders = await this.orders
      .find({ _id: { $in: page.items.map((s) => s.orderId) } })
      .lean()
      .exec();
    const orderById = new Map(orders.map((o) => [o._id.toHexString(), o]));

    const items = page.items.flatMap((shipment) => {
      const order = orderById.get(shipment.orderId.toHexString());
      if (!order) return [];
      const daysLate = Math.floor(
        (now.getTime() - shipment.estimatedDeliveryAt.getTime()) / DAY_MS,
      );
      return [{ order, shipment, daysLate }];
    });
    return { ...page, items };
  }
}
