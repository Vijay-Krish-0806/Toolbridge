import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type QueryFilter } from 'mongoose';
import { paginate, type Page } from '../common/query.js';
import type { Inventory } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { Product } from '../domain/product.schema.js';
import type { ListInventoryQuery } from './inventory.dto.js';

type StockRow = Inventory & { available: number };

const withAvailable = (row: Inventory): StockRow => ({
  ...row,
  available: row.onHand - row.reserved,
});

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(MODEL.Inventory.name) private readonly inventory: Model<Inventory>,
    @InjectModel(MODEL.Product.name) private readonly products: Model<Product>,
  ) {}

  async list(query: ListInventoryQuery): Promise<Page<StockRow>> {
    const filter: QueryFilter<Inventory> = {};
    if (query.warehouse) filter.warehouse = query.warehouse;
    if (query.productId) filter.productId = new Types.ObjectId(query.productId);
    // $expr compares two fields of the same document: available (onHand - reserved) < reorderLevel.
    if (query.lowStock !== undefined) {
      const isLow = { $lt: [{ $subtract: ['$onHand', '$reserved'] }, '$reorderLevel'] };
      filter.$expr = query.lowStock ? isLow : { $not: [isLow] };
    }
    const page = await paginate(this.inventory, filter, { productId: 1, warehouse: 1 }, query);
    return { ...page, items: page.items.map(withAvailable) };
  }

  async forProduct(productId: Types.ObjectId) {
    const product = await this.products.findById(productId).lean().exec();
    if (!product) throw new NotFoundException(`No product with id ${productId.toHexString()}.`);
    const rows = (
      await this.inventory.find({ productId }).sort({ warehouse: 1 }).lean().exec()
    ).map(withAvailable);
    return {
      productId: product._id,
      sku: product.sku,
      name: product.name,
      totalAvailable: rows.reduce((sum, row) => sum + row.available, 0),
      warehouses: rows,
    };
  }
}
