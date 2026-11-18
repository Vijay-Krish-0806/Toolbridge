import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageOf, PageQuery, ToBoolean } from '../common/query.js';

export const PRODUCT_CATEGORIES = ['electronics', 'home', 'outdoor', 'apparel', 'fitness'] as const;

export class ListProductsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PRODUCT_CATEGORIES, description: 'Only this category.' })
  @IsOptional()
  @IsIn(PRODUCT_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({ description: 'true = on sale, false = discontinued.', example: true })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Minimum price in cents (inclusive).', example: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @ApiPropertyOptional({ description: 'Maximum price in cents (inclusive).', example: 5000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @ApiPropertyOptional({
    description: 'Case-insensitive text to find in the product name.',
    example: 'lamp',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  search?: string;
}

export class ProductDto {
  @ApiProperty({ example: '6a1f0a800100000000000001' })
  _id!: string;

  @ApiProperty({ description: 'Stock keeping unit, unique per product.', example: 'SKU-0001' })
  sku!: string;

  @ApiProperty({ example: 'Compact Lamp' })
  name!: string;

  @ApiProperty({ enum: PRODUCT_CATEGORIES, example: 'home' })
  category!: string;

  @ApiProperty({ example: 'Compact lamp from our home range.' })
  description!: string;

  @ApiProperty({ description: 'Current price in cents. 2499 means $24.99.', example: 2499 })
  priceCents!: number;

  @ApiProperty({ description: 'false means discontinued: not sold to new orders.' })
  active!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ProductPage extends PageOf(ProductDto) {}

export class CreateProductDto {
  @ApiProperty({ description: 'Unique SKU: "SKU-" and at least four digits.', example: 'SKU-0500' })
  @Matches(/^SKU-\d{4,}$/i)
  sku!: string;

  @ApiProperty({ example: 'Travel Mug' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: PRODUCT_CATEGORIES, example: 'home' })
  @IsIn(PRODUCT_CATEGORIES)
  category!: string;

  @ApiProperty({ example: 'Insulated travel mug from our home range.' })
  @IsString()
  @MaxLength(1000)
  description!: string;

  @ApiProperty({ description: 'Price in cents.', example: 1999 })
  @IsInt()
  @Min(1)
  priceCents!: number;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Travel Mug XL' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'New price in cents.', example: 2499 })
  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @ApiPropertyOptional({ description: 'false = discontinue: no new orders.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class BulkPriceUpdateDto {
  @ApiPropertyOptional({
    enum: PRODUCT_CATEGORIES,
    description: 'Change every product in this category. Give category OR skus, not both.',
  })
  @IsOptional()
  @IsIn(PRODUCT_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Change exactly these SKUs (1 to 200). Give category OR skus, not both.',
    example: ['SKU-0001', 'SKU-0002'],
  })
  @IsOptional()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  skus?: string[];

  @ApiPropertyOptional({
    description:
      'Percent change, -90 to 500. 10 raises prices by 10%. Give changePercent OR setPriceCents.',
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(-90)
  @Max(500)
  changePercent?: number;

  @ApiPropertyOptional({
    description:
      'Set every matched product to this price in cents. Give changePercent OR setPriceCents.',
    example: 1999,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  setPriceCents?: number;

  @ApiPropertyOptional({
    description: 'true (default) only previews the changes. Send false to apply them.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun: boolean = true;
}

export class PriceChangeDto {
  @ApiProperty({ example: 'SKU-0001' })
  sku!: string;

  @ApiProperty({ example: 'Travel Gloves' })
  name!: string;

  @ApiProperty({ example: 1999 })
  oldPriceCents!: number;

  @ApiProperty({ example: 2199 })
  newPriceCents!: number;
}

export class BulkPriceUpdateResultDto {
  @ApiProperty({ description: 'true = nothing was changed; this is a preview.' })
  dryRun!: boolean;

  @ApiProperty({ description: 'Products matched by the filter.', example: 24 })
  matched!: number;

  @ApiProperty({ description: 'Products whose price changes (or would change).', example: 24 })
  changed!: number;

  @ApiProperty({ type: [PriceChangeDto], description: 'Up to the first 50 changes, by SKU.' })
  changes!: PriceChangeDto[];
}
