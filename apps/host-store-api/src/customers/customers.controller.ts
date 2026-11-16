import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Page } from '../common/query.js';
import type { Customer } from '../domain/customer.schema.js';
import type { Order } from '../domain/order.schema.js';
import type { Role } from '../domain/user.schema.js';
import { CustomerOrdersQuery, OrderPage } from '../orders/orders.dto.js';
import { OrdersService } from '../orders/orders.service.js';
import { CustomerCommandsService } from './customer-commands.service.js';
import {
  CustomerDto,
  CustomerPage,
  ListCustomersQuery,
  UpdateCustomerDto,
} from './customers.dto.js';
import { CustomersService } from './customers.service.js';

// Customer records hold personal data, so warehouse staff cannot read them.
const CUSTOMER_ROLES: Role[] = ['owner', 'support'];

@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
    private readonly commands: CustomerCommandsService,
  ) {}

  @Get()
  @Endpoint({
    summary: 'List customers',
    description:
      'Sorted by name. Filter by name or email text, loyalty tier, or country code. Use this ' +
      'to find a customer id from a name or email.',
    ok: CustomerPage,
    roles: CUSTOMER_ROLES,
  })
  list(@Query() query: ListCustomersQuery): Promise<Page<Customer>> {
    return this.customers.list(query);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get a customer by id',
    description: 'Returns contact details, address, loyalty tier and notes for one customer.',
    ok: CustomerDto,
    roles: CUSTOMER_ROLES,
    notFound: 'No customer has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Customer> {
    return this.customers.getById(id);
  }

  @Get(':id/orders')
  @Endpoint({
    summary: "List a customer's orders",
    description: 'All orders placed by one customer, newest first.',
    ok: OrderPage,
    roles: CUSTOMER_ROLES,
    notFound: 'No customer has this id.',
  })
  async listOrders(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Query() query: CustomerOrdersQuery,
  ): Promise<Page<Order>> {
    await this.customers.getById(id); // 404 for an unknown customer, rather than an empty list
    return this.orders.forCustomer(id, query);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Update a customer',
    description:
      'Changes phone, address (replaced as a whole) or notes. Send only the fields to change. ' +
      'Name and email are not editable here.',
    ok: CustomerDto,
    roles: CUSTOMER_ROLES,
    notFound: 'No customer has this id.',
  })
  update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: UpdateCustomerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Customer> {
    return this.commands.update(id, body, user);
  }
}
