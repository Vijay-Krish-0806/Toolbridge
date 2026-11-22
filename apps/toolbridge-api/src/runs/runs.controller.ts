import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { ApprovalsService } from './approvals.service.js';
import { DecideApprovalDto, ListApprovalsQuery, StartRunDto } from './runs.dto.js';
import { RunsService } from './runs.service.js';

/** Agent runs (Step 4.3). Tenant from the API key only; another tenant's run is a 404. */
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** 202 Accepted: the run was saved and runs in the background; poll GET /runs/:id. */
  @Post()
  @HttpCode(202)
  start(@CurrentCaller() caller: Caller, @Body() dto: StartRunDto) {
    return this.runs.start(caller.tenantId, dto);
  }

  @Get(':runId')
  get(@CurrentCaller() caller: Caller, @Param('runId') runId: string) {
    return this.runs.get(caller.tenantId, runId);
  }

  /** 202 Accepted: a waiting run is cancelled at once; a running one is stopped by its worker. */
  @Post(':runId/cancel')
  @HttpCode(202)
  cancel(@CurrentCaller() caller: Caller, @Param('runId') runId: string) {
    return this.runs.cancel(caller.tenantId, runId);
  }
}

/** Approval cards: the inbox, and approving or rejecting with a reason. */
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentCaller() caller: Caller, @Query() query: ListApprovalsQuery) {
    return this.approvals.list(caller.tenantId, query.status);
  }

  /** 202 Accepted: the decision is recorded and the run continues in the background. */
  @Post(':approvalId/approve')
  @HttpCode(202)
  approve(
    @CurrentCaller() caller: Caller,
    @Param('approvalId') approvalId: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(caller.tenantId, approvalId, 'approved', dto);
  }

  @Post(':approvalId/reject')
  @HttpCode(202)
  reject(
    @CurrentCaller() caller: Caller,
    @Param('approvalId') approvalId: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(caller.tenantId, approvalId, 'rejected', dto);
  }
}
