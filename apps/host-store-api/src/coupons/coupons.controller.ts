import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Role } from '../domain/user.schema.js';
import { CouponCommandsService } from './coupon-commands.service.js';
import { CouponDto, CouponPage, CreateCouponDto, ListCouponsQuery } from './coupons.dto.js';
import { CouponsService } from './coupons.service.js';

const COUPON_ROLES: Role[] = ['owner', 'support'];

@ApiTags('coupons')
@Controller('coupons')
export class CouponsController {
  constructor(
    private readonly coupons: CouponsService,
    private readonly commands: CouponCommandsService,
  ) {}

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

  @Post()
  @Endpoint({
    summary: 'Create a coupon',
    description:
      'Adds an active coupon. kind=percent takes value% off; kind=fixed takes value cents off. ' +
      'Codes are capital letters and digits.',
    ok: CouponDto,
    created: true,
    roles: ['owner'],
    conflict: 'A coupon with this code already exists.',
  })
  async create(@Body() body: CreateCouponDto, @CurrentUser() user: AuthUser) {
    await this.commands.create(body, user);
    return this.coupons.getByCode(body.code); // includes the computed "usable" flag
  }

  @Post(':code/deactivate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Deactivate a coupon',
    description: 'Switches a coupon off so new orders cannot use it. Past orders are not changed.',
    ok: CouponDto,
    roles: ['owner'],
    notFound: 'No coupon has this code.',
    conflict: 'The coupon is already inactive.',
  })
  async deactivate(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    await this.commands.deactivate(code, user);
    return this.coupons.getByCode(code);
  }
}
