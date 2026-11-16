import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsMongoId, IsOptional } from 'class-validator';
import { PageOf, PageQuery, ToBoolean } from '../common/query.js';
import {
  CARRIERS,
  SHIPMENT_STATUSES,
  type Carrier,
  type ShipmentStatus,
} from '../domain/shipment.schema.js';

export class ListShipmentsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: SHIPMENT_STATUSES, description: 'Only shipments in this status.' })
  @IsOptional()
  @IsIn(SHIPMENT_STATUSES)
  status?: ShipmentStatus;

  @ApiPropertyOptional({ enum: CARRIERS, description: 'Only this carrier.' })
  @IsOptional()
  @IsIn(CARRIERS)
  carrier?: Carrier;

  @ApiPropertyOptional({ description: 'Only shipments for this order id.' })
  @IsOptional()
  @IsMongoId()
  orderId?: string;

  @ApiPropertyOptional({
    description: 'true = still in transit after the estimated delivery date.',
    example: true,
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delayed?: boolean;
}

export class ShipmentDto {
  @ApiProperty({ example: '6ac62630060000000000000a' })
  _id!: string;

  @ApiProperty({ example: '6ac4d4b00500000000000001' })
  orderId!: string;

  @ApiProperty({ enum: CARRIERS, example: 'ups' })
  carrier!: Carrier;

  @ApiProperty({ example: 'TRK00000010' })
  trackingNumber!: string;

  @ApiProperty({ enum: SHIPMENT_STATUSES, example: 'in_transit' })
  status!: ShipmentStatus;

  @ApiProperty({ format: 'date-time' })
  shippedAt!: string;

  @ApiProperty({ format: 'date-time' })
  estimatedDeliveryAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deliveredAt!: string | null;
}

export class ShipmentPage extends PageOf(ShipmentDto) {}
