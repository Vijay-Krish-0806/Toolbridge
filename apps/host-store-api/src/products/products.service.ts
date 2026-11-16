import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { containsText, paginate, type Page } from '../common/query.js';
import { MODEL } from '../domain/models.js';
import type { Product } from '../domain/product.schema.js';
import type { ListProductsQuery } from './products.dto.js';

@Injectable()
export class ProductsService {
  constructor(@InjectModel(MODEL.Product.name) private readonly products: Model<Product>) {}

  list(query: ListProductsQuery): Promise<Page<Product>> {
    const filter: QueryFilter<Product> = {};
    if (query.category) filter.category = query.category;
    if (query.active !== undefined) filter.active = query.active;
    if (query.search) filter.name = containsText(query.search);
    if (query.minPriceCents !== undefined || query.maxPriceCents !== undefined) {
      filter.priceCents = {
        ...(query.minPriceCents !== undefined ? { $gte: query.minPriceCents } : {}),
        ...(query.maxPriceCents !== undefined ? { $lte: query.maxPriceCents } : {}),
      };
    }
    return paginate(this.products, filter, { sku: 1 }, query);
  }

  async getById(id: Types.ObjectId): Promise<Product> {
    const product = await this.products.findById(id).lean().exec();
    if (!product) throw new NotFoundException(`No product with id ${id.toHexString()}.`);
    return product;
  }

  async getBySku(sku: string): Promise<Product> {
    const product = await this.products.findOne({ sku: sku.toUpperCase() }).lean().exec();
    if (!product) throw new NotFoundException(`No product with SKU ${sku}.`);
    return product;
  }
}
