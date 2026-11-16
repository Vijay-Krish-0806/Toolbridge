import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
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
