import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { OrderCommandsService } from './order-commands.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      MODEL.Order,
      MODEL.Shipment,
      MODEL.Customer,
      MODEL.Product,
      MODEL.Inventory,
      MODEL.Coupon,
    ]),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderCommandsService],
  exports: [OrdersService],
})
export class OrdersModule {}
