import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PageOf, PageQuery, ToBoolean } from '../common/query.js';
import { COUPON_KINDS, type CouponKind } from '../domain/coupon.schema.js';

export class ListCouponsQuery extends PageQuery {
  @ApiPropertyOptional({
    description: 'true = switched on by staff. Expiry is separate.',
    example: true,
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ enum: COUPON_KINDS, description: 'percent or fixed (cents) discount.' })
  @IsOptional()
  @IsIn(COUPON_KINDS)
  kind?: CouponKind;
}

export class CouponDto {
  @ApiProperty({ example: '64a4c8800400000000000001' })
  _id!: string;

  @ApiProperty({ example: 'SAVE20' })
  code!: string;

  @ApiProperty({ enum: COUPON_KINDS, example: 'percent' })
  kind!: CouponKind;

  @ApiProperty({
    description: 'Percent off for percent coupons, or cents off for fixed.',
    example: 20,
  })
  value!: number;

  @ApiProperty({ description: 'Switched on by staff.' })
  active!: boolean;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'null = unlimited.', example: 20 })
  maxUses!: number | null;

  @ApiProperty({ example: 9 })
  timesUsed!: number;

  @ApiProperty({
    description: 'Computed now: active, not expired, and below maxUses. Only usable coupons apply.',
  })
  usable!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class CouponPage extends PageOf(CouponDto) {}
