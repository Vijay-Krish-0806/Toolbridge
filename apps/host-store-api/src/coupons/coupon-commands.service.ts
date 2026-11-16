import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, type Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { Clock } from '../common/clock.js';
import { isDuplicateKey, notFoundOrConflict } from '../common/errors.js';
import type { Coupon } from '../domain/coupon.schema.js';
import { MODEL } from '../domain/models.js';
import type { CreateCouponDto } from './coupons.dto.js';

@Injectable()
export class CouponCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Coupon.name) private readonly coupons: Model<Coupon>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateCouponDto, actor: AuthUser): Promise<void> {
    const now = this.clock.now();
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt <= now) throw new BadRequestException('expiresAt must be in the future.');
    if (dto.kind === 'percent' && dto.value > 100) {
      throw new BadRequestException('A percent coupon cannot take off more than 100%.');
    }
    try {
      await this.connection.transaction(async (session) => {
        const [coupon] = await this.coupons.create(
          [
            {
              code: dto.code,
              kind: dto.kind,
              value: dto.value,
              active: true,
              expiresAt,
              maxUses: dto.maxUses ?? null,
              timesUsed: 0,
              createdAt: now,
            },
          ],
          { session },
        );
        if (!coupon) throw new Error('Coupon insert returned nothing');
        await this.audit.record(
          actor,
          { action: 'coupon.create', targetType: 'coupon', targetId: coupon.code },
          session,
        );
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException(`Coupon ${dto.code} already exists.`);
      throw error;
    }
  }

  deactivate(code: string, actor: AuthUser): Promise<void> {
    const upper = code.toUpperCase();
    return this.connection.transaction(async (session) => {
      const coupon = await this.coupons
        .findOneAndUpdate(
          { code: upper, active: true },
          { $set: { active: false } },
          { session, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!coupon) {
        const found = await this.coupons.findOne({ code: upper }).session(session).lean().exec();
        throw notFoundOrConflict(
          found && { status: 'already inactive' },
          `Coupon ${upper}`,
          'Nothing to change.',
        );
      }
      await this.audit.record(
        actor,
        { action: 'coupon.deactivate', targetType: 'coupon', targetId: upper },
        session,
      );
    });
  }
}
