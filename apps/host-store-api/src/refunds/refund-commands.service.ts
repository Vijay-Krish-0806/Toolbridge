import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types, type Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import { notFoundOrConflict } from '../common/errors.js';
import { MODEL } from '../domain/models.js';
import type { Order } from '../domain/order.schema.js';
import type { Refund, RefundReason } from '../domain/refund.schema.js';

/**
 * Two-step refunds: support or owner requests (pending), only the owner approves or rejects.
 * A request counts against the order immediately, so two requests cannot together exceed it.
 */
@Injectable()
export class RefundCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(MODEL.Order.name) private readonly orders: Model<Order>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  request(
    orderId: string,
    amountCents: number,
    reason: RefundReason,
    actor: AuthUser,
  ): Promise<Refund> {
    return this.connection.transaction(async (session) => {
      const id = new Types.ObjectId(orderId);
      // Check and count in ONE atomic update: refundCommittedCents + amount must stay <= total.
      // A separate "read the sum, then insert" would let two parallel requests both pass.
      const order = await this.orders
        .findOneAndUpdate(
          {
            _id: id,
            status: { $in: ['shipped', 'delivered'] },
            $expr: { $lte: [{ $add: ['$refundCommittedCents', amountCents] }, '$totalCents'] },
          },
          { $inc: { refundCommittedCents: amountCents } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!order) {
        const found = await this.orders.findById(id).session(session).lean().exec();
        if (!found) throw new NotFoundException(`Order ${orderId} does not exist.`);
        if (found.status !== 'shipped' && found.status !== 'delivered') {
          throw new ConflictException(
            `Order ${found.number} is ${found.status}. Only shipped or delivered orders can be refunded.`,
          );
        }
        const left = found.totalCents - found.refundCommittedCents;
        throw new ConflictException(
          `Order ${found.number} has only ${String(left)} cents left to refund (pending and completed refunds count).`,
        );
      }

      const [refund] = await this.refunds.create(
        [
          {
            orderId: id,
            amountCents,
            reason,
            status: 'pending',
            requestedAt: this.clock.now(),
            requestedBy: new Types.ObjectId(actor.id),
            processedAt: null,
            processedBy: null,
            decisionNote: null,
          },
        ],
        { session },
      );
      if (!refund) throw new Error('Refund insert returned nothing');
      await this.audit.record(
        actor,
        {
          action: 'refund.request',
          targetType: 'refund',
          targetId: refund._id.toHexString(),
          details: { orderId, amountCents, reason },
        },
        session,
      );
      return refund.toObject();
    });
  }

  approve(id: Types.ObjectId, note: string | undefined, actor: AuthUser): Promise<Refund> {
    return this.decide(id, 'completed', note ?? null, actor);
  }

  reject(id: Types.ObjectId, note: string, actor: AuthUser): Promise<Refund> {
    return this.decide(id, 'rejected', note, actor);
  }

  private decide(
    id: Types.ObjectId,
    status: 'completed' | 'rejected',
    note: string | null,
    actor: AuthUser,
  ): Promise<Refund> {
    return this.connection.transaction(async (session) => {
      const refund = await this.refunds
        .findOneAndUpdate(
          { _id: id, status: 'pending' },
          {
            $set: {
              status,
              processedAt: this.clock.now(),
              processedBy: new Types.ObjectId(actor.id),
              decisionNote: note,
            },
          },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!refund) {
        const found = await this.refunds.findById(id, { status: 1 }).session(session).lean().exec();
        throw notFoundOrConflict(
          found,
          `Refund ${id.toHexString()}`,
          'Only pending refunds can be decided.',
        );
      }
      if (status === 'rejected') {
        // A rejected refund no longer counts against the order.
        await this.orders
          .updateOne(
            { _id: refund.orderId },
            { $inc: { refundCommittedCents: -refund.amountCents } },
            { session },
          )
          .exec();
      }
      await this.audit.record(
        actor,
        {
          action: status === 'completed' ? 'refund.approve' : 'refund.reject',
          targetType: 'refund',
          targetId: id.toHexString(),
          details: { amountCents: refund.amountCents, note },
        },
        session,
      );
      return refund;
    });
  }
}
