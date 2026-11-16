import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Endpoint } from '../common/endpoint.decorator.js';
import { InventoryPage, ListInventoryQuery, ProductStockDto } from './inventory.dto.js';
import { InventoryService } from './inventory.service.js';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Endpoint({
    summary: 'List stock levels',
    description:
      'One row per product per warehouse (east, west). Filter by warehouse, product, or ' +
      'lowStock=true to find items that need reordering.',
    ok: InventoryPage,
  })
  list(@Query() query: ListInventoryQuery) {
    return this.inventory.list(query);
  }

  @Get('products/:productId')
  @Endpoint({
    summary: 'Get stock for one product',
    description: 'Stock in every warehouse for one product, plus the total available to sell.',
    ok: ProductStockDto,
    notFound: 'No product has this id.',
  })
  forProduct(@Param('productId', ParseObjectIdPipe) productId: Types.ObjectId) {
    return this.inventory.forProduct(productId);
  }
}
