import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Endpoint } from '../common/endpoint.decorator.js';
import { PageQuery, type Page } from '../common/query.js';
import type { Order } from '../domain/order.schema.js';
import { DelayedOrderPage, ListOrdersQuery, OrderDto, OrderPage } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Endpoint({
    summary: 'List orders',
    description:
      'Newest first. Filter by status, customer id, placement date range (from/to), minimum ' +
      'total in cents, or coupon code. To find late deliveries use GET /orders/delayed instead.',
    ok: OrderPage,
  })
  list(@Query() query: ListOrdersQuery): Promise<Page<Order>> {
    return this.orders.list(query);
  }

  @Get('delayed')
  @Endpoint({
    summary: 'List delayed orders',
    description:
      'Orders whose shipment is still in transit after its estimated delivery date, most ' +
      'overdue first. Each item has the order, its shipment and how many days late it is.',
    ok: DelayedOrderPage,
  })
  delayed(@Query() query: PageQuery) {
    return this.orders.delayed(query);
  }

  @Get('by-number/:number')
  @Endpoint({
    summary: 'Get an order by order number',
    description: 'Looks up one order by its number, for example ORD-10042. Case-insensitive.',
    ok: OrderDto,
    notFound: 'No order has this number.',
  })
  getByNumber(@Param('number') number: string): Promise<Order> {
    return this.orders.getByNumber(number);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get an order by id',
    description: 'Returns one order with its line items, totals in cents, coupon and notes.',
    ok: OrderDto,
    notFound: 'No order has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Order> {
    return this.orders.getById(id);
  }
}
