import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types, type Connection, type QueryFilter } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import { isDuplicateKey } from '../common/errors.js';
import { WAREHOUSES, type Inventory } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { Product } from '../domain/product.schema.js';
import type {
  BulkPriceUpdateDto,
  BulkPriceUpdateResultDto,
  CreateProductDto,
  UpdateProductDto,
} from './products.dto.js';

const PREVIEW_LIMIT = 50;

@Injectable()
export class ProductCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Product.name) private readonly products: Model<Product>,
    @InjectModel(MODEL.Inventory.name) private readonly inventory: Model<Inventory>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Creates the product and an empty stock row in every warehouse. */
  async create(dto: CreateProductDto, actor: AuthUser): Promise<Product> {
    try {
      return await this.connection.transaction(async (session) => {
        const [product] = await this.products.create(
          [
            {
              sku: dto.sku.toUpperCase(),
              name: dto.name,
              category: dto.category,
              description: dto.description,
              priceCents: dto.priceCents,
              active: true,
              createdAt: this.clock.now(),
            },
          ],
          { session },
        );
        if (!product) throw new Error('Product insert returned nothing');
        await this.inventory.create(
          WAREHOUSES.map((warehouse) => ({
            productId: product._id,
            warehouse,
            onHand: 0,
            reserved: 0,
            reorderLevel: 20,
          })),
          { session, ordered: true },
        );
        await this.audit.record(
          actor,
          { action: 'product.create', targetType: 'product', targetId: product._id.toHexString() },
          session,
        );
        return product.toObject();
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException(`SKU ${dto.sku} already exists.`);
      throw error;
    }
  }

  update(id: Types.ObjectId, dto: UpdateProductDto, actor: AuthUser): Promise<Product> {
    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }
    return this.connection.transaction(async (session) => {
      const before = await this.products
        .findByIdAndUpdate(id, { $set: changes }, { session, returnDocument: 'before' })
        .lean()
        .exec();
      if (!before) throw new NotFoundException(`Product ${id.toHexString()} does not exist.`);
      await this.audit.record(
        actor,
        {
          action: 'product.update',
          targetType: 'product',
          targetId: id.toHexString(),
          details: { changes, oldPriceCents: before.priceCents },
        },
        session,
      );
      return { ...before, ...changes };
    });
  }

  /**
   * RISKY: changes many prices at once. Defaults to a dry run that only reports what would
   * change, so a caller (person or agent) sees the effect before committing to it.
   */
  async bulkPriceUpdate(
    dto: BulkPriceUpdateDto,
    actor: AuthUser,
  ): Promise<BulkPriceUpdateResultDto> {
    if ((dto.category === undefined) === (dto.skus === undefined)) {
      throw new BadRequestException('Give exactly one of category or skus.');
    }
    if ((dto.changePercent === undefined) === (dto.setPriceCents === undefined)) {
      throw new BadRequestException('Give exactly one of changePercent or setPriceCents.');
    }

    const filter: QueryFilter<Product> = dto.category
      ? { category: dto.category }
      : { sku: { $in: (dto.skus ?? []).map((s) => s.toUpperCase()) } };
    const matched = await this.products.find(filter).sort({ sku: 1 }).lean().exec();
    const newPrice = (old: number) =>
      dto.setPriceCents ?? Math.max(1, Math.round((old * (100 + (dto.changePercent ?? 0))) / 100));
    const changes = matched
      .map((p) => ({
        id: p._id,
        sku: p.sku,
        name: p.name,
        oldPriceCents: p.priceCents,
        newPriceCents: newPrice(p.priceCents),
      }))
      .filter((c) => c.newPriceCents !== c.oldPriceCents);

    if (!dto.dryRun && changes.length > 0) {
      await this.connection.transaction(async (session) => {
        // Each update only applies if the price is still the one we previewed (optimistic check).
        const result = await this.products.bulkWrite(
          changes.map((c) => ({
            updateOne: {
              filter: { _id: c.id, priceCents: c.oldPriceCents },
              update: { $set: { priceCents: c.newPriceCents } },
            },
          })),
          { session },
        );
        if (result.modifiedCount !== changes.length) {
          throw new ConflictException(
            'Some prices changed during the update. Nothing was applied; try again.',
          );
        }
        await this.audit.record(
          actor,
          {
            action: 'product.bulk_price_update',
            targetType: 'product',
            targetId: dto.category ?? 'skus',
            details: {
              rule: { changePercent: dto.changePercent, setPriceCents: dto.setPriceCents },
              changed: changes.length,
            },
          },
          session,
        );
      });
    }

    return {
      dryRun: dto.dryRun,
      matched: matched.length,
      changed: changes.length,
      changes: changes
        .slice(0, PREVIEW_LIMIT)
        .map(({ sku, name, oldPriceCents, newPriceCents }) => ({
          sku,
          name,
          oldPriceCents,
          newPriceCents,
        })),
    };
  }
}
