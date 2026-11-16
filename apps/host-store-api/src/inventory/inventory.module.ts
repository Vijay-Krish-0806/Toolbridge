import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Inventory, MODEL.Product])],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
