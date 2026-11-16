import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import type { Coupon } from '../domain/coupon.schema.js';
import { WAREHOUSES } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { FormDto, FormFieldDto } from './forms.dto.js';

/**
 * The order form changes with the data and the caller, so it cannot be fully described by a
 * fixed OpenAPI schema: coupon options come from coupons usable right now, and the
 * manual-discount field appears only for the owner. Clients read this before POST /orders.
 */
@Injectable()
export class FormsService {
  constructor(
    @InjectModel(MODEL.Coupon.name) private readonly coupons: Model<Coupon>,
    private readonly clock: Clock,
  ) {}

  async orderForm(user: AuthUser): Promise<FormDto> {
    const now = this.clock.now();
    const usable = await this.coupons
      .find({
        active: true,
        expiresAt: { $gt: now },
        $or: [{ maxUses: null }, { $expr: { $lt: ['$timesUsed', '$maxUses'] } }],
      })
      .sort({ code: 1 })
      .lean()
      .exec();

    const fields: FormFieldDto[] = [
      {
        name: 'customerId',
        label: 'Customer',
        type: 'string',
        required: true,
        description: 'Id of the customer placing the order.',
        lookup: { method: 'GET', path: '/customers?search=', valueField: '_id' },
      },
      {
        name: 'items',
        label: 'Items',
        type: 'array',
        required: true,
        description: 'Products and quantities. Each SKU at most once.',
        min: 1,
        max: 20,
        itemFields: [
          {
            name: 'sku',
            label: 'Product SKU',
            type: 'string',
            required: true,
            description: 'An active product.',
            lookup: { method: 'GET', path: '/products?active=true&search=', valueField: 'sku' },
          },
          {
            name: 'quantity',
            label: 'Quantity',
            type: 'integer',
            required: true,
            description: 'Units of this product.',
            min: 1,
            max: 100,
          },
        ],
      },
      {
        name: 'warehouse',
        label: 'Warehouse',
        type: 'enum',
        required: false,
        description: 'Leave empty to use the first warehouse that has every item in stock.',
        options: [...WAREHOUSES],
      },
      {
        name: 'couponCode',
        label: 'Coupon code',
        type: 'enum',
        required: false,
        description: 'Only coupons usable right now are listed.',
        options: usable.map((c) => c.code),
      },
      {
        name: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Delivery or gift instructions.',
        max: 1000,
      },
    ];
    if (user.role === 'owner') {
      fields.push({
        name: 'manualDiscountCents',
        label: 'Manual discount (cents)',
        type: 'integer',
        required: false,
        description: 'Extra discount on top of any coupon. Owner only.',
        min: 1,
      });
    }

    return {
      formId: 'order.create',
      title: 'Create an order',
      submit: { method: 'POST', path: '/orders' },
      generatedAt: now.toISOString(),
      fields,
    };
  }
}
