import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { ProductCommandsService } from './product-commands.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Product, MODEL.Inventory])],
  controllers: [ProductsController],
  providers: [ProductsService, ProductCommandsService],
})
export class ProductsModule {}
