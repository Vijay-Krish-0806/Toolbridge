import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { OrdersModule } from '../orders/orders.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Customer]), OrdersModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
