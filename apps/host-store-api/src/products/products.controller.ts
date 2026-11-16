import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Page } from '../common/query.js';
import type { Product } from '../domain/product.schema.js';
import { ListProductsQuery, ProductDto, ProductPage } from './products.dto.js';
import { ProductsService } from './products.service.js';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Endpoint({
    summary: 'List products',
    description:
      'Searches the catalog. Filter by category, active status, price range (cents) or name text. ' +
      'Sorted by SKU. Use this to find a product id or SKU before other calls.',
    ok: ProductPage,
  })
  list(@Query() query: ListProductsQuery): Promise<Page<Product>> {
    return this.products.list(query);
  }

  @Get('by-sku/:sku')
  @Endpoint({
    summary: 'Get a product by SKU',
    description: 'Looks up one product by its SKU, for example SKU-0042. Case-insensitive.',
    ok: ProductDto,
    notFound: 'No product has this SKU.',
  })
  getBySku(@Param('sku') sku: string): Promise<Product> {
    return this.products.getBySku(sku);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get a product by id',
    description: 'Returns one product, including its current price and whether it is still sold.',
    ok: ProductDto,
    notFound: 'No product has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Product> {
    return this.products.getById(id);
  }
}
