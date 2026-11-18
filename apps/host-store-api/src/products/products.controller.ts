import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { ApiObjectIdParam } from '../common/api-object-id-param.js';
import type { Page } from '../common/query.js';
import type { Product } from '../domain/product.schema.js';
import { ProductCommandsService } from './product-commands.service.js';
import {
  BulkPriceUpdateDto,
  BulkPriceUpdateResultDto,
  CreateProductDto,
  ListProductsQuery,
  ProductDto,
  ProductPage,
  UpdateProductDto,
} from './products.dto.js';
import { ProductsService } from './products.service.js';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly commands: ProductCommandsService,
  ) {}

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
  @ApiObjectIdParam('id')
  @Endpoint({
    summary: 'Get a product by id',
    description: 'Returns one product, including its current price and whether it is still sold.',
    ok: ProductDto,
    notFound: 'No product has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Product> {
    return this.products.getById(id);
  }

  @Post()
  @Endpoint({
    summary: 'Create a product',
    description: 'Adds a product to the catalog, on sale, with zero stock in every warehouse.',
    ok: ProductDto,
    created: true,
    roles: ['owner'],
    conflict: 'The SKU already exists.',
  })
  create(@Body() body: CreateProductDto, @CurrentUser() user: AuthUser): Promise<Product> {
    return this.commands.create(body, user);
  }

  @Post('bulk-price-update')
  @HttpCode(200)
  @Endpoint({
    summary: 'Change many prices at once',
    description:
      'RISKY: changes the price of every product in a category, or of a list of SKUs, by a ' +
      'percentage or to a fixed price. dryRun defaults to true and only previews the changes; ' +
      'send dryRun=false to apply them. Existing orders keep the prices they were placed at.',
    ok: BulkPriceUpdateResultDto,
    roles: ['owner'],
    conflict: 'Prices changed while applying the update; nothing was applied.',
  })
  bulkPriceUpdate(
    @Body() body: BulkPriceUpdateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BulkPriceUpdateResultDto> {
    return this.commands.bulkPriceUpdate(body, user);
  }

  @Patch(':id')
  @ApiObjectIdParam('id')
  @Endpoint({
    summary: 'Update a product',
    description:
      'Changes name, description, price (cents) or active flag. Send only the fields to change. ' +
      'active=false discontinues the product.',
    ok: ProductDto,
    roles: ['owner'],
    notFound: 'No product has this id.',
  })
  update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Product> {
    return this.commands.update(id, body, user);
  }
}
