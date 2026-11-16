import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { CouponCommandsService } from './coupon-commands.service.js';
import { CouponsController } from './coupons.controller.js';
import { CouponsService } from './coupons.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Coupon])],
  controllers: [CouponsController],
  providers: [CouponsService, CouponCommandsService],
})
export class CouponsModule {}
