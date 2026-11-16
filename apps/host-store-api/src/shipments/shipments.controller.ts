import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Page } from '../common/query.js';
import type { Shipment } from '../domain/shipment.schema.js';
import { ListShipmentsQuery, ShipmentDto, ShipmentPage } from './shipments.dto.js';
import { ShipmentsService } from './shipments.service.js';

@ApiTags('shipments')
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @Endpoint({
    summary: 'List shipments',
    description:
      'Most recently shipped first. Filter by status, carrier, order id, or delayed=true for ' +
      'shipments still in transit after their estimated delivery date.',
    ok: ShipmentPage,
  })
  list(@Query() query: ListShipmentsQuery): Promise<Page<Shipment>> {
    return this.shipments.list(query);
  }

  @Get('by-tracking/:trackingNumber')
  @Endpoint({
    summary: 'Get a shipment by tracking number',
    description: 'Looks up one shipment by carrier tracking number, for example TRK00000010.',
    ok: ShipmentDto,
    notFound: 'No shipment has this tracking number.',
  })
  getByTracking(@Param('trackingNumber') trackingNumber: string): Promise<Shipment> {
    return this.shipments.getByTracking(trackingNumber);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get a shipment by id',
    description:
      'Returns carrier, tracking number, status and the shipped, estimated and delivered dates.',
    ok: ShipmentDto,
    notFound: 'No shipment has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Shipment> {
    return this.shipments.getById(id);
  }
}
