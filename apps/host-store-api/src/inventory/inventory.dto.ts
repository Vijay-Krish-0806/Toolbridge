import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';
import { PageOf, PageQuery, ToBoolean } from '../common/query.js';
import { WAREHOUSES, type Warehouse } from '../domain/inventory.schema.js';

export class ListInventoryQuery extends PageQuery {
  @ApiPropertyOptional({ enum: WAREHOUSES, description: 'Only this warehouse.' })
  @IsOptional()
  @IsIn(WAREHOUSES)
  warehouse?: Warehouse;

  @ApiPropertyOptional({ description: 'Only rows for this product id.' })
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @ApiPropertyOptional({
    description:
      'true = only rows where available stock (onHand - reserved) is below the reorder level.',
    example: true,
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  lowStock?: boolean;
}

export class InventoryDto {
  @ApiProperty({ example: '6a1f0a800200000000000001' })
  _id!: string;

  @ApiProperty({ example: '6a1f0a800100000000000001' })
  productId!: string;

  @ApiProperty({ enum: WAREHOUSES, example: 'east' })
  warehouse!: Warehouse;

  @ApiProperty({ description: 'Units physically in the warehouse.', example: 42 })
  onHand!: number;

  @ApiProperty({ description: 'Units held for orders not yet shipped.', example: 5 })
  reserved!: number;

  @ApiProperty({ description: 'Units free to sell: onHand - reserved.', example: 37 })
  available!: number;

  @ApiProperty({ description: 'Reorder when available stock drops below this.', example: 20 })
  reorderLevel!: number;
}

export class InventoryPage extends PageOf(InventoryDto) {}

export class ProductStockDto {
  @ApiProperty({ example: '6a1f0a800100000000000001' })
  productId!: string;

  @ApiProperty({ example: 'SKU-0001' })
  sku!: string;

  @ApiProperty({ example: 'Compact Lamp' })
  name!: string;

  @ApiProperty({ description: 'Available units across all warehouses.', example: 61 })
  totalAvailable!: number;

  @ApiProperty({ type: [InventoryDto] })
  warehouses!: InventoryDto[];
}

export class AdjustStockDto {
  @ApiProperty({ description: 'Product id.' })
  @IsMongoId()
  productId!: string;

  @ApiProperty({ enum: WAREHOUSES, example: 'east' })
  @IsIn(WAREHOUSES)
  warehouse!: Warehouse;

  @ApiProperty({
    description:
      'Units to add (positive) or remove (negative), -10000 to 10000, not 0. On-hand stock ' +
      'can never drop below the units reserved for open orders.',
    example: -3,
  })
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  @NotEquals(0)
  delta!: number;

  @ApiProperty({
    description: 'Why the count changed. Kept in the audit log.',
    example: 'Damaged in storage.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
