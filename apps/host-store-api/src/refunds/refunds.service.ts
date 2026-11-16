import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type QueryFilter } from 'mongoose';
import { dateRange, paginate, type Page } from '../common/query.js';
import { MODEL } from '../domain/models.js';
import type { Refund } from '../domain/refund.schema.js';
import type { ListRefundsQuery } from './refunds.dto.js';

@Injectable()
export class RefundsService {
  constructor(@InjectModel(MODEL.Refund.name) private readonly refunds: Model<Refund>) {}

  list(query: ListRefundsQuery): Promise<Page<Refund>> {
    const filter: QueryFilter<Refund> = {};
    if (query.status) filter.status = query.status;
    if (query.reason) filter.reason = query.reason;
    if (query.orderId) filter.orderId = new Types.ObjectId(query.orderId);
    if (query.minAmountCents !== undefined) filter.amountCents = { $gte: query.minAmountCents };
    const requested = dateRange(query.from, query.to);
    if (requested) filter.requestedAt = requested;
    return paginate(this.refunds, filter, { requestedAt: -1 }, query);
  }

  async getById(id: Types.ObjectId): Promise<Refund> {
    const refund = await this.refunds.findById(id).lean().exec();
    if (!refund) throw new NotFoundException(`No refund with id ${id.toHexString()}.`);
    return refund;
  }
}
