import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { ApiObjectIdParam } from '../common/api-object-id-param.js';
import type { Page } from '../common/query.js';
import type { Refund } from '../domain/refund.schema.js';
import type { Role } from '../domain/user.schema.js';
import { RefundCommandsService } from './refund-commands.service.js';
import {
  ApproveRefundDto,
  ListRefundsQuery,
  RefundDto,
  RefundPage,
  RejectRefundDto,
  RequestRefundDto,
} from './refunds.dto.js';
import { RefundsService } from './refunds.service.js';

const REFUND_ROLES: Role[] = ['owner', 'support'];

@ApiTags('refunds')
@Controller('refunds')
export class RefundsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly commands: RefundCommandsService,
  ) {}

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
  @ApiObjectIdParam('id')
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

  @Post()
  @Endpoint({
    summary: 'Request a refund',
    description:
      'RISKY: creates a pending refund for a shipped or delivered order. The amount counts ' +
      'against the order at once and cannot exceed what is left to refund. Money moves only ' +
      'when the owner approves it with POST /refunds/{id}/approve.',
    ok: RefundDto,
    created: true,
    roles: REFUND_ROLES,
    notFound: 'The order does not exist.',
    conflict: 'The order is not shipped or delivered, or the amount exceeds what is left.',
  })
  request(@Body() body: RequestRefundDto, @CurrentUser() user: AuthUser): Promise<Refund> {
    return this.commands.request(body.orderId, body.amountCents, body.reason, user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiObjectIdParam('id')
  @Endpoint({
    summary: 'Approve a refund',
    description: 'RISKY: completes a pending refund, so the money goes back to the customer.',
    ok: RefundDto,
    roles: ['owner'],
    notFound: 'No refund has this id.',
    conflict: 'The refund is not pending.',
  })
  approve(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: ApproveRefundDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Refund> {
    return this.commands.approve(id, body.note, user);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiObjectIdParam('id')
  @Endpoint({
    summary: 'Reject a refund',
    description:
      'Declines a pending refund with a reason. Its amount no longer counts against the order.',
    ok: RefundDto,
    roles: ['owner'],
    notFound: 'No refund has this id.',
    conflict: 'The refund is not pending.',
  })
  reject(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() body: RejectRefundDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Refund> {
    return this.commands.reject(id, body.note, user);
  }
}
