import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { InventoryCommandsService } from './inventory-commands.service.js';
import {
  AdjustStockDto,
  InventoryDto,
  InventoryPage,
  ListInventoryQuery,
  ProductStockDto,
} from './inventory.dto.js';
import { InventoryService } from './inventory.service.js';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly commands: InventoryCommandsService,
  ) {}

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

  @Post('adjust')
  @HttpCode(200)
  @Endpoint({
    summary: 'Correct a stock count',
    description:
      'Adds or removes on-hand units in one warehouse, for example after a recount or damage. ' +
      'The reason is kept in the audit log. Use POST /shipments to ship orders, not this.',
    ok: InventoryDto,
    roles: ['owner', 'warehouse'],
    notFound: 'No stock row for this product and warehouse.',
    conflict: 'On-hand stock would drop below the units reserved for open orders.',
  })
  adjust(@Body() body: AdjustStockDto, @CurrentUser() user: AuthUser) {
    return this.commands.adjust(body, user);
  }
}
