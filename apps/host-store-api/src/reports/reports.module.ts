import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Order, MODEL.Refund])],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
