import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

@Module({
  imports: [MongooseModule.forFeature([MODEL.Coupon])],
  controllers: [FormsController],
  providers: [FormsService],
})
export class FormsModule {}
