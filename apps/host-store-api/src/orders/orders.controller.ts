import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { PageQuery, type Page } from '../common/query.js';
import type { Order } from '../domain/order.schema.js';
import type { Role } from '../domain/user.schema.js';
import { OrderCommandsService } from './order-commands.service.js';
import { DelayedOrderPage, ListOrdersQuery, OrderDto, OrderPage } from './orders.dto.js';
import { OrdersService } from './orders.service.js';
import { CancelOrderDto, CreateOrderDto, UpdateOrderNotesDto } from './orders.write.dto.js';

const ORDER_WRITE_ROLES: Role[] = ['owner', 'support'];

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly commands: OrderCommandsService,
  ) {}

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

  @Post()
  @Endpoint({
    summary: 'Create an order',
    description:
      'Creates a pending order for a customer. Prices come from the catalog (not the request), ' +
      'the coupon must be usable now, and stock is reserved in one warehouse. Use GET ' +
      '/forms/order first to see the fields, current coupon codes and role-specific options.',
    ok: OrderDto,
    created: true,
    roles: ORDER_WRITE_ROLES,
    notFound: 'The customer does not exist.',
    conflict: 'Not enough stock, a discontinued product, or a coupon that cannot be used now.',
  })
  create(@Body() body: CreateOrderDto, @CurrentUser() user: AuthUser): Promise<Order> {
    return this.commands.create(body, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Endpoint({
    summary: 'Cancel an order',
    description:
      'RISKY: stops the order for good. Only pending or paid orders can be cancelled; their ' +
      'reserved stock goes back to the warehouse. Shipped orders need a refund instead.',
    ok: OrderDto,
    roles: ORDER_WRITE_ROLES,
    notFound: 'No order has this id.',
    conflict: 'The order is already shipped, delivered or cancelled.',
  })
  cancel(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: CancelOrderDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Order> {
    return this.commands.cancel(id, body.reason, user);
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  @Endpoint({
    summary: 'Mark an order as paid',
    description: 'Moves a pending order to paid, so the warehouse can ship it.',
    ok: OrderDto,
    roles: ORDER_WRITE_ROLES,
    notFound: 'No order has this id.',
    conflict: 'The order is not pending.',
  })
  markPaid(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @CurrentUser() user: AuthUser,
  ): Promise<Order> {
    return this.commands.markPaid(id, user);
  }

  @Patch(':id/notes')
  @Endpoint({
    summary: 'Replace the notes on an order',
    description: 'Overwrites the free-text notes of an order. Send an empty string to clear them.',
    ok: OrderDto,
    roles: ORDER_WRITE_ROLES,
    notFound: 'No order has this id.',
  })
  updateNotes(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: UpdateOrderNotesDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Order> {
    return this.commands.updateNotes(id, body.notes, user);
  }
}
