import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Refund])],
  controllers: [RefundsController],
  providers: [RefundsService],
})
export class RefundsModule {}
