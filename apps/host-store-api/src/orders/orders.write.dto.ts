import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WAREHOUSES, type Warehouse } from '../domain/inventory.schema.js';

export class OrderLineDto {
  @ApiProperty({ description: 'Product SKU. Find it with GET /products.', example: 'SKU-0042' })
  @IsString()
  @MinLength(1)
  sku!: string;

  @ApiProperty({ minimum: 1, maximum: 100, example: 2 })
  @IsInt()
  @Min(1)
  @Max(100)
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'Customer id. Find it with GET /customers?search=.' })
  @IsMongoId()
  customerId!: string;

  @ApiProperty({
    type: [OrderLineDto],
    description: '1 to 20 lines. Each SKU at most once; use quantity for more units.',
  })
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  items!: OrderLineDto[];

  @ApiPropertyOptional({
    enum: WAREHOUSES,
    description: 'Default: the first warehouse that has every item in stock.',
  })
  @IsOptional()
  @IsIn(WAREHOUSES)
  warehouse?: Warehouse;

  @ApiPropertyOptional({
    description: 'Coupon code. Must be usable now (see GET /forms/order for current codes).',
    example: 'SAVE20',
  })
  @IsOptional()
  @IsString()
  couponCode?: string;

  @ApiPropertyOptional({
    description: 'Extra discount in cents, on top of any coupon. Owner only.',
    example: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  manualDiscountCents?: number;

  @ApiPropertyOptional({ maxLength: 1000, example: 'Gift wrap, please.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CancelOrderDto {
  @ApiProperty({
    description: 'Why the order is cancelled.',
    example: 'Customer changed their mind.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class UpdateOrderNotesDto {
  @ApiProperty({
    description: 'Replaces the current notes. Empty string clears them.',
    maxLength: 1000,
  })
  @IsString()
  @MaxLength(1000)
  notes!: string;
}
