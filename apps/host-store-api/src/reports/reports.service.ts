import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '../common/clock.js';
import { MODEL } from '../domain/models.js';
import type { Order } from '../domain/order.schema.js';
import type { Refund } from '../domain/refund.schema.js';
import type { RefundSummaryDto, ReportRangeQuery, SalesSummaryDto } from './reports.dto.js';

const DEFAULT_PERIOD_DAYS = 30;

interface Bucket {
  key: string;
  count: number;
  amountCents: number;
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(MODEL.Order.name) private readonly orders: Model<Order>,
    @InjectModel(MODEL.Refund.name) private readonly refunds: Model<Refund>,
    private readonly clock: Clock,
  ) {}

  async sales(query: ReportRangeQuery): Promise<SalesSummaryDto> {
    const { from, to } = this.period(query);
    // One aggregation pass: group every order in the period into "cancelled" or "kept".
    const groups = await this.orders
      .aggregate<{ _id: boolean; count: number; gross: number; discount: number; net: number }>([
        { $match: { placedAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $eq: ['$status', 'cancelled'] },
            count: { $sum: 1 },
            gross: { $sum: '$subtotalCents' },
            discount: { $sum: '$discountCents' },
            net: { $sum: '$totalCents' },
          },
        },
      ])
      .exec();
    const kept = groups.find((g) => !g._id);
    const cancelled = groups.find((g) => g._id);
    const orderCount = kept?.count ?? 0;
    const netCents = kept?.net ?? 0;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      orderCount,
      cancelledCount: cancelled?.count ?? 0,
      grossCents: kept?.gross ?? 0,
      discountCents: kept?.discount ?? 0,
      netCents,
      averageOrderCents: orderCount > 0 ? Math.round(netCents / orderCount) : 0,
    };
  }

  async refundSummary(query: ReportRangeQuery): Promise<RefundSummaryDto> {
    const { from, to } = this.period(query);
    const bucketsBy = (field: 'status' | 'reason') => ({
      [field]: [
        {
          $group: {
            _id: `$${field}`,
            count: { $sum: 1 },
            amountCents: { $sum: '$amountCents' },
          },
        },
        { $project: { _id: 0, key: '$_id', count: 1, amountCents: 1 } },
        { $sort: { key: 1 as const } },
      ],
    });
    // $facet runs both groupings over the same matched refunds in one query.
    const [result] = await this.refunds
      .aggregate<{ status: Bucket[]; reason: Bucket[] }>([
        { $match: { requestedAt: { $gte: from, $lt: to } } },
        { $facet: { ...bucketsBy('status'), ...bucketsBy('reason') } },
      ])
      .exec();
    const byStatus = result?.status ?? [];
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      count: byStatus.reduce((sum, b) => sum + b.count, 0),
      amountCents: byStatus.reduce((sum, b) => sum + b.amountCents, 0),
      byStatus,
      byReason: result?.reason ?? [],
    };
  }

  private period(query: ReportRangeQuery): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : this.clock.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_PERIOD_DAYS * 86_400_000);
    if (from >= to) throw new BadRequestException('"from" must be before "to".');
    return { from, to };
  }
}
