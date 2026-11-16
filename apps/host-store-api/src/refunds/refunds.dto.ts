import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, Min } from 'class-validator';
import { DateRangePageQuery, PageOf } from '../common/query.js';
import {
  REFUND_REASONS,
  REFUND_STATUSES,
  type RefundReason,
  type RefundStatus,
} from '../domain/refund.schema.js';

export class ListRefundsQuery extends DateRangePageQuery {
  @ApiPropertyOptional({ enum: REFUND_STATUSES, description: 'Only refunds in this status.' })
  @IsOptional()
  @IsIn(REFUND_STATUSES)
  status?: RefundStatus;

  @ApiPropertyOptional({ enum: REFUND_REASONS, description: 'Only refunds with this reason.' })
  @IsOptional()
  @IsIn(REFUND_REASONS)
  reason?: RefundReason;

  @ApiPropertyOptional({ description: 'Only refunds for this order id.' })
  @IsOptional()
  @IsMongoId()
  orderId?: string;

  @ApiPropertyOptional({
    description: 'Minimum refund amount in cents (inclusive).',
    example: 50000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAmountCents?: number;
}

export class RefundDto {
  @ApiProperty({ example: '6ad1ef200700000000000001' })
  _id!: string;

  @ApiProperty({ example: '6ac4d4b00500000000000001' })
  orderId!: string;

  @ApiProperty({ description: 'Amount refunded or requested, in cents.', example: 12999 })
  amountCents!: number;

  @ApiProperty({ enum: REFUND_REASONS, example: 'damaged' })
  reason!: RefundReason;

  @ApiProperty({
    enum: REFUND_STATUSES,
    description: 'pending = awaiting a decision, completed = money returned, rejected = declined.',
  })
  status!: RefundStatus;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processedAt!: string | null;
}

export class RefundPage extends PageOf(RefundDto) {}
