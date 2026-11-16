import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Matches, Min } from 'class-validator';
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

export class CreateCouponDto {
  @ApiProperty({ description: '3 to 20 capital letters or digits.', example: 'WINTER15' })
  @Matches(/^[A-Z0-9]{3,20}$/)
  code!: string;

  @ApiProperty({ enum: COUPON_KINDS, example: 'percent' })
  @IsIn(COUPON_KINDS)
  kind!: CouponKind;

  @ApiProperty({
    description: 'Percent off (1 to 100) for percent coupons, or cents off for fixed coupons.',
    example: 15,
  })
  @IsInt()
  @Min(1)
  value!: number;

  @ApiProperty({
    description: 'Expiry, ISO 8601. Must be in the future.',
    example: '2027-01-31T00:00:00.000Z',
  })
  @IsISO8601()
  expiresAt!: string;

  @ApiPropertyOptional({ description: 'Maximum number of uses. Omit for unlimited.', example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;
}
