import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter } from 'mongoose';
import { Clock } from '../common/clock.js';
import { paginate, type Page } from '../common/query.js';
import type { Coupon } from '../domain/coupon.schema.js';
import { MODEL } from '../domain/models.js';
import type { ListCouponsQuery } from './coupons.dto.js';

type CouponView = Coupon & { usable: boolean };

@Injectable()
export class CouponsService {
  constructor(
    @InjectModel(MODEL.Coupon.name) private readonly coupons: Model<Coupon>,
    private readonly clock: Clock,
  ) {}

  async list(query: ListCouponsQuery): Promise<Page<CouponView>> {
    const filter: QueryFilter<Coupon> = {};
    if (query.active !== undefined) filter.active = query.active;
    if (query.kind) filter.kind = query.kind;
    const page = await paginate(this.coupons, filter, { code: 1 }, query);
    return { ...page, items: page.items.map((c) => this.withUsable(c)) };
  }

  async getByCode(code: string): Promise<CouponView> {
    const coupon = await this.coupons.findOne({ code: code.toUpperCase() }).lean().exec();
    if (!coupon) throw new NotFoundException(`No coupon with code ${code}.`);
    return this.withUsable(coupon);
  }

  private withUsable(coupon: Coupon): CouponView {
    const usable =
      coupon.active &&
      coupon.expiresAt > this.clock.now() &&
      (coupon.maxUses === null || coupon.timesUsed < coupon.maxUses);
    return { ...coupon, usable };
  }
}
