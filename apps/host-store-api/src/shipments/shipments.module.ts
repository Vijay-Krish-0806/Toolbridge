import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { ShipmentCommandsService } from './shipment-commands.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Shipment, MODEL.Order, MODEL.Inventory])],
  controllers: [ShipmentsController],
  providers: [ShipmentsService, ShipmentCommandsService],
})
export class ShipmentsModule {}
