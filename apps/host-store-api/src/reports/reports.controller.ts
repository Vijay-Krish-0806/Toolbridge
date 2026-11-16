import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint } from '../common/endpoint.decorator.js';
import { RefundSummaryDto, ReportRangeQuery, SalesSummaryDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales-summary')
  @Endpoint({
    summary: 'Sales summary for a period',
    description:
      'Order count, gross, discounts, net revenue and average order value (all in cents) for ' +
      'orders placed in the period. Cancelled orders are counted separately and excluded from ' +
      'revenue. Defaults to the last 30 days.',
    ok: SalesSummaryDto,
    roles: ['owner'],
  })
  sales(@Query() query: ReportRangeQuery): Promise<SalesSummaryDto> {
    return this.reports.sales(query);
  }

  @Get('refund-summary')
  @Endpoint({
    summary: 'Refund summary for a period',
    description:
      'Count and total of refunds requested in the period, broken down by status and by ' +
      'reason (amounts in cents). Defaults to the last 30 days.',
    ok: RefundSummaryDto,
    roles: ['owner'],
  })
  refunds(@Query() query: ReportRangeQuery): Promise<RefundSummaryDto> {
    return this.reports.refundSummary(query);
  }
}
