import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { RefundCommandsService } from './refund-commands.service.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Refund, MODEL.Order])],
  controllers: [RefundsController],
  providers: [RefundsService, RefundCommandsService],
})
export class RefundsModule {}
