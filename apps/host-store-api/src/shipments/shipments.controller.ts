import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { ApiObjectIdParam } from '../common/api-object-id-param.js';
import type { Page } from '../common/query.js';
import type { Shipment } from '../domain/shipment.schema.js';
import { ShipmentCommandsService } from './shipment-commands.service.js';
import {
  CreateShipmentDto,
  ListShipmentsQuery,
  ShipmentDto,
  ShipmentPage,
} from './shipments.dto.js';
import { ShipmentsService } from './shipments.service.js';

@ApiTags('shipments')
@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly commands: ShipmentCommandsService,
  ) {}

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
  @ApiObjectIdParam('id')
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

  @Post()
  @Endpoint({
    summary: 'Ship a paid order',
    description:
      'Creates a shipment with a new tracking number for a paid order. The order becomes ' +
      'shipped, and its reserved units are removed from the warehouse stock.',
    ok: ShipmentDto,
    created: true,
    roles: ['owner', 'warehouse'],
    notFound: 'The order does not exist.',
    conflict: 'The order is not paid, or the stock record does not cover it.',
  })
  create(@Body() body: CreateShipmentDto, @CurrentUser() user: AuthUser): Promise<Shipment> {
    return this.commands.create(body.orderId, body.carrier, user);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @ApiObjectIdParam('id')
  @Endpoint({
    summary: 'Mark a shipment as delivered',
    description: 'Records delivery now. The order becomes delivered.',
    ok: ShipmentDto,
    roles: ['owner', 'warehouse'],
    notFound: 'No shipment has this id.',
    conflict: 'The shipment is already delivered.',
  })
  deliver(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @CurrentUser() user: AuthUser,
  ): Promise<Shipment> {
    return this.commands.deliver(id, user);
  }
}
