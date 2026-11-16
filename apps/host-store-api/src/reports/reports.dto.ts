import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

export class ReportRangeQuery {
  @ApiPropertyOptional({
    description: 'Start of the period (inclusive), ISO 8601. Default: 30 days before now.',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the period (exclusive), ISO 8601. Default: now.',
    example: '2026-11-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class SalesSummaryDto {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({
    description: 'Orders placed in the period, excluding cancelled ones.',
    example: 74,
  })
  orderCount!: number;

  @ApiProperty({ description: 'Orders placed in the period and later cancelled.', example: 3 })
  cancelledCount!: number;

  @ApiProperty({ description: 'Sum of subtotals before discounts, in cents.', example: 2512345 })
  grossCents!: number;

  @ApiProperty({ description: 'Sum of coupon discounts, in cents.', example: 81200 })
  discountCents!: number;

  @ApiProperty({ description: 'Amount charged (gross - discounts), in cents.', example: 2431145 })
  netCents!: number;

  @ApiProperty({ description: 'netCents / orderCount, rounded, in cents.', example: 32853 })
  averageOrderCents!: number;
}

class RefundBucketDto {
  @ApiProperty({ description: 'The status or reason this bucket groups.', example: 'completed' })
  key!: string;

  @ApiProperty({ example: 12 })
  count!: number;

  @ApiProperty({ example: 456700 })
  amountCents!: number;
}

export class RefundSummaryDto {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ description: 'Refunds requested in the period.', example: 18 })
  count!: number;

  @ApiProperty({
    description: 'Sum of all requested amounts in the period, in cents.',
    example: 612300,
  })
  amountCents!: number;

  @ApiProperty({ type: [RefundBucketDto] })
  byStatus!: RefundBucketDto[];

  @ApiProperty({ type: [RefundBucketDto] })
  byReason!: RefundBucketDto[];
}
