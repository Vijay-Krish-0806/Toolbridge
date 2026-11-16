import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Endpoint } from '../common/endpoint.decorator.js';
import type { Page } from '../common/query.js';
import type { Refund } from '../domain/refund.schema.js';
import type { Role } from '../domain/user.schema.js';
import { ListRefundsQuery, RefundDto, RefundPage } from './refunds.dto.js';
import { RefundsService } from './refunds.service.js';

const REFUND_ROLES: Role[] = ['owner', 'support'];

@ApiTags('refunds')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @Endpoint({
    summary: 'List refunds',
    description:
      'Newest request first. Filter by status, reason, order id, request date range (from/to), ' +
      'or minimum amount in cents.',
    ok: RefundPage,
    roles: REFUND_ROLES,
  })
  list(@Query() query: ListRefundsQuery): Promise<Page<Refund>> {
    return this.refunds.list(query);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get a refund by id',
    description: 'Returns one refund: amount in cents, reason, status and dates.',
    ok: RefundDto,
    roles: REFUND_ROLES,
    notFound: 'No refund has this id.',
  })
  getById(@Param('id', ParseObjectIdPipe) id: Types.ObjectId): Promise<Refund> {
    return this.refunds.getById(id);
  }
}
