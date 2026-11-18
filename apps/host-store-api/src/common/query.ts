import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import type { Model, QueryFilter, SortOrder } from 'mongoose';

export const MAX_PAGE_SIZE = 100;

/** Page-number pagination: ?page=1&limit=20. Simple for agents and people; fine at this data size. */
export class PageQuery {
  @ApiPropertyOptional({
    description: 'Page number, starting at 1.',
    type: 'integer',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `Items per page, at most ${String(MAX_PAGE_SIZE)}.`,
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 20;
}

/** Adds an optional date range. `from` is inclusive and `to` is exclusive. */
export class DateRangePageQuery extends PageQuery {
  @ApiPropertyOptional({
    description: 'Start of the date range (inclusive), ISO 8601.',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the date range (exclusive), ISO 8601.',
    example: '2026-11-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export async function paginate<T>(
  model: Model<T>,
  filter: QueryFilter<T>,
  sort: Record<string, SortOrder>,
  { page, limit }: PageQuery,
): Promise<Page<T>> {
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<T[]>()
      .exec(),
    model.countDocuments(filter).exec(),
  ]);
  return { items, page, limit, total };
}

/** Builds a Mongo date condition, or undefined when neither bound is given. */
export function dateRange(from?: string, to?: string) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { $gte: new Date(from) } : {}),
    ...(to ? { $lt: new Date(to) } : {}),
  };
}

/** Treats user input as plain text inside a regular expression (no regex injection). */
export function containsText(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** Query strings arrive as text: turn "true"/"false" into booleans before validation. */
export const ToBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/**
 * Builds a named "page of X" response class for Swagger. Swagger needs a concrete class
 * per item type, so each feature declares e.g. `class ProductPage extends PageOf(ProductDto) {}`.
 */
export function PageOf<T>(item: new () => T) {
  class PageDto {
    @ApiProperty({ type: [item] })
    items!: T[];

    @ApiProperty({ example: 1 })
    page!: number;

    @ApiProperty({ example: 20 })
    limit!: number;

    @ApiProperty({ description: 'Total matching items across all pages.', example: 137 })
    total!: number;
  }
  return PageDto;
}
