import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types, type Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import type { Inventory } from '../domain/inventory.schema.js';
import { MODEL } from '../domain/models.js';
import type { AdjustStockDto } from './inventory.dto.js';

@Injectable()
export class InventoryCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Inventory.name) private readonly inventory: Model<Inventory>,
    private readonly audit: AuditService,
  ) {}

  /** Corrects a stock count. Refuses to drop on-hand below what open orders have reserved. */
  adjust(dto: AdjustStockDto, actor: AuthUser) {
    return this.connection.transaction(async (session) => {
      const productId = new Types.ObjectId(dto.productId);
      const row = await this.inventory
        .findOneAndUpdate(
          {
            productId,
            warehouse: dto.warehouse,
            $expr: { $gte: [{ $add: ['$onHand', dto.delta] }, '$reserved'] },
          },
          { $inc: { onHand: dto.delta } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!row) {
        const found = await this.inventory
          .findOne({ productId, warehouse: dto.warehouse })
          .session(session)
          .lean()
          .exec();
        if (!found)
          throw new NotFoundException(`No stock row for this product in ${dto.warehouse}.`);
        throw new ConflictException(
          `On-hand would drop to ${String(found.onHand + dto.delta)}, below the ${String(found.reserved)} units reserved for open orders.`,
        );
      }
      await this.audit.record(
        actor,
        {
          action: 'inventory.adjust',
          targetType: 'inventory',
          targetId: row._id.toHexString(),
          details: { delta: dto.delta, reason: dto.reason, onHandAfter: row.onHand },
        },
        session,
      );
      return { ...row, available: row.onHand - row.reserved };
    });
  }
}
