import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Role } from '../domain/user.schema.js';
import { CouponDto, CouponPage, ListCouponsQuery } from './coupons.dto.js';
import { CouponsService } from './coupons.service.js';

const COUPON_ROLES: Role[] = ['owner', 'support'];

@ApiTags('coupons')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @Endpoint({
    summary: 'List coupons',
    description:
      'Sorted by code. Filter by active flag or kind. Each coupon includes "usable": whether ' +
      'it can be applied right now (active, not expired, uses left).',
    ok: CouponPage,
    roles: COUPON_ROLES,
  })
  list(@Query() query: ListCouponsQuery) {
    return this.coupons.list(query);
  }

  @Get(':code')
  @Endpoint({
    summary: 'Get a coupon by code',
    description: 'Looks up one coupon by its code, for example SAVE20. Case-insensitive.',
    ok: CouponDto,
    roles: COUPON_ROLES,
    notFound: 'No coupon has this code.',
  })
  getByCode(@Param('code') code: string) {
    return this.coupons.getByCode(code);
  }
}
