import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types, type ClientSession, type Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import { notFoundOrConflict } from '../common/errors.js';
import type { Coupon } from '../domain/coupon.schema.js';
import type { Customer } from '../domain/customer.schema.js';
import { WAREHOUSES, type Inventory, type Warehouse } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { Order, OrderItem } from '../domain/order.schema.js';
import { couponDiscountCents } from '../domain/pricing.js';
import type { Product } from '../domain/product.schema.js';
import type { CreateOrderDto } from './orders.write.dto.js';

/**
 * Order writes. Each one runs in a MongoDB transaction: the order, the stock it reserves or
 * releases, the coupon count and the audit record all commit together or not at all.
 * State changes use conditional updates ("only if still pending"), so two requests racing to
 * cancel the same order cannot both succeed.
 */
@Injectable()
export class OrderCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Order.name) private readonly orders: Model<Order>,
    @InjectModel(MODEL.Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(MODEL.Product.name) private readonly products: Model<Product>,
    @InjectModel(MODEL.Inventory.name) private readonly inventory: Model<Inventory>,
    @InjectModel(MODEL.Coupon.name) private readonly coupons: Model<Coupon>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateOrderDto, actor: AuthUser): Promise<Order> {
    if (dto.manualDiscountCents !== undefined && actor.role !== 'owner') {
      throw new ForbiddenException('Only the owner may give a manual discount.');
    }
    const skus = dto.items.map((line) => line.sku.toUpperCase());
    if (new Set(skus).size !== skus.length) {
      throw new BadRequestException('Each SKU may appear only once. Use quantity for more units.');
    }

    return this.connection.transaction(async (session) => {
      const now = this.clock.now();
      const customerId = new Types.ObjectId(dto.customerId);
      if (!(await this.customers.exists({ _id: customerId }).session(session))) {
        throw new NotFoundException(`Customer ${dto.customerId} does not exist.`);
      }

      const items = await this.priceItems(dto, session);
      const subtotalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
      const { couponCode, couponDiscount } = await this.useCoupon(
        dto.couponCode,
        subtotalCents,
        now,
        session,
      );
      const discountCents = couponDiscount + (dto.manualDiscountCents ?? 0);
      if (discountCents > subtotalCents) {
        throw new BadRequestException('Discounts cannot exceed the order subtotal.');
      }

      const warehouse = dto.warehouse ?? (await this.pickWarehouse(items, session));
      for (const item of items) {
        // Reserve only if available stock (onHand - reserved) covers the quantity, in one atomic step.
        const result = await this.inventory
          .updateOne(
            {
              productId: item.productId,
              warehouse,
              $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, item.quantity] },
            },
            { $inc: { reserved: item.quantity } },
            { session },
          )
          .exec();
        if (result.modifiedCount === 0) {
          throw new ConflictException(
            `Not enough ${item.sku} in stock in the ${warehouse} warehouse.`,
          );
        }
      }

      const [order] = await this.orders.create(
        [
          {
            number: await this.nextOrderNumber(session),
            customerId,
            status: 'pending',
            warehouse,
            items,
            subtotalCents,
            discountCents,
            totalCents: subtotalCents - discountCents,
            couponCode,
            refundCommittedCents: 0,
            notes: dto.notes ?? '',
            cancellation: null,
            placedAt: now,
          },
        ],
        { session },
      );
      if (!order) throw new Error('Order insert returned nothing');
      await this.audit.record(
        actor,
        {
          action: 'order.create',
          targetType: 'order',
          targetId: order._id.toHexString(),
          details: { number: order.number, totalCents: order.totalCents },
        },
        session,
      );
      return order.toObject();
    });
  }

  cancel(id: Types.ObjectId, reason: string, actor: AuthUser): Promise<Order> {
    return this.connection.transaction(async (session) => {
      const order = await this.orders
        .findOneAndUpdate(
          { _id: id, status: { $in: ['pending', 'paid'] } },
          {
            $set: {
              status: 'cancelled',
              cancellation: { by: new Types.ObjectId(actor.id), reason, at: this.clock.now() },
            },
          },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!order) {
        const found = await this.orders.findById(id, { status: 1 }).session(session).lean().exec();
        throw notFoundOrConflict(
          found,
          `Order ${id.toHexString()}`,
          'Only pending or paid orders can be cancelled.',
        );
      }

      // Give the reserved units back to the warehouse.
      for (const item of order.items) {
        await this.inventory
          .updateOne(
            {
              productId: item.productId,
              warehouse: order.warehouse,
              reserved: { $gte: item.quantity },
            },
            { $inc: { reserved: -item.quantity } },
            { session },
          )
          .exec();
      }
      await this.audit.record(
        actor,
        {
          action: 'order.cancel',
          targetType: 'order',
          targetId: id.toHexString(),
          details: { reason },
        },
        session,
      );
      return order;
    });
  }

  markPaid(id: Types.ObjectId, actor: AuthUser): Promise<Order> {
    return this.connection.transaction(async (session) => {
      const order = await this.orders
        .findOneAndUpdate(
          { _id: id, status: 'pending' },
          { $set: { status: 'paid' } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!order) {
        const found = await this.orders.findById(id, { status: 1 }).session(session).lean().exec();
        throw notFoundOrConflict(
          found,
          `Order ${id.toHexString()}`,
          'Only pending orders can be marked paid.',
        );
      }
      await this.audit.record(
        actor,
        { action: 'order.mark_paid', targetType: 'order', targetId: id.toHexString() },
        session,
      );
      return order;
    });
  }

  updateNotes(id: Types.ObjectId, notes: string, actor: AuthUser): Promise<Order> {
    return this.connection.transaction(async (session) => {
      const order = await this.orders
        .findByIdAndUpdate(id, { $set: { notes } }, { session, returnDocument: 'after' })
        .lean()
        .exec();
      if (!order) throw new NotFoundException(`Order ${id.toHexString()} does not exist.`);
      await this.audit.record(
        actor,
        { action: 'order.update_notes', targetType: 'order', targetId: id.toHexString() },
        session,
      );
      return order;
    });
  }

  /** Copies each product's current name and price into the line: the price snapshot. */
  private async priceItems(dto: CreateOrderDto, session: ClientSession): Promise<OrderItem[]> {
    const skus = dto.items.map((line) => line.sku.toUpperCase());
    const products = await this.products
      .find({ sku: { $in: skus } })
      .session(session)
      .lean()
      .exec();
    const bySku = new Map(products.map((p) => [p.sku, p]));
    return dto.items.map((line) => {
      const product = bySku.get(line.sku.toUpperCase());
      if (!product) throw new BadRequestException(`Unknown SKU ${line.sku}.`);
      if (!product.active) throw new ConflictException(`${product.sku} is discontinued.`);
      return {
        productId: product._id,
        sku: product.sku,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: line.quantity,
      };
    });
  }

  /** Counts one use of the coupon, only if it is usable right now (one atomic check-and-update). */
  private async useCoupon(
    code: string | undefined,
    subtotalCents: number,
    now: Date,
    session: ClientSession,
  ) {
    if (!code) return { couponCode: null, couponDiscount: 0 };
    const coupon = await this.coupons
      .findOneAndUpdate(
        {
          code: code.toUpperCase(),
          active: true,
          expiresAt: { $gt: now },
          $or: [{ maxUses: null }, { $expr: { $lt: ['$timesUsed', '$maxUses'] } }],
        },
        { $inc: { timesUsed: 1 } },
        { session, returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!coupon) {
      throw new ConflictException(
        `Coupon ${code} cannot be used now: unknown, inactive, expired or used up.`,
      );
    }
    return { couponCode: coupon.code, couponDiscount: couponDiscountCents(coupon, subtotalCents) };
  }

  private async pickWarehouse(items: OrderItem[], session: ClientSession): Promise<Warehouse> {
    const rows = await this.inventory
      .find({ productId: { $in: items.map((i) => i.productId) } })
      .session(session)
      .lean()
      .exec();
    const available = (productId: Types.ObjectId, warehouse: Warehouse) => {
      const row = rows.find((r) => r.productId.equals(productId) && r.warehouse === warehouse);
      return row ? row.onHand - row.reserved : 0;
    };
    const warehouse = WAREHOUSES.find((w) =>
      items.every((item) => available(item.productId, w) >= item.quantity),
    );
    if (!warehouse) throw new ConflictException('No single warehouse has every item in stock.');
    return warehouse;
  }

  /** Next ORD-number. Two orders created at the same instant could pick the same number; the
   * unique index rejects the second and its transaction rolls back (the caller can retry). */
  private async nextOrderNumber(session: ClientSession): Promise<string> {
    const last = await this.orders
      .findOne({}, { number: 1 })
      .sort({ number: -1 })
      .session(session)
      .lean()
      .exec();
    const lastNumber = last ? Number(last.number.replace('ORD-', '')) : 10_000;
    return `ORD-${String(lastNumber + 1)}`;
  }
}
