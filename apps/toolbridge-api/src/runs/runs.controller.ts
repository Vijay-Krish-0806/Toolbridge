import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { EventLog } from '../events/event-log.js';
import { resumePoint, streamRunEvents } from '../events/event-stream.js';
import { ApprovalsService } from './approvals.service.js';
import { DecideApprovalDto, ListApprovalsQuery, StartRunDto } from './runs.dto.js';
import { RunsService } from './runs.service.js';

/** Agent runs (Steps 4.3, 4.4a). Tenant from the API key only; another tenant's run is a 404. */
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly events: EventLog,
  ) {}

  /** 202 Accepted: the run was saved and queued; follow it with GET /runs/:id/events. */
  @Post()
  @HttpCode(202)
  start(@CurrentCaller() caller: Caller, @Body() dto: StartRunDto) {
    return this.runs.start(caller.tenantId, dto);
  }

  @Get(':runId')
  get(@CurrentCaller() caller: Caller, @Param('runId') runId: string) {
    return this.runs.get(caller.tenantId, runId);
  }

  /**
   * The run's public events as Server-Sent Events (docs/run-events.md). Use fetch with an
   * `Authorization` header (never a token in the URL); resume with `Last-Event-ID` or `?after=`.
   * The run is looked up first, so another tenant's run is a plain 404, not an empty stream.
   * `@Res()` hands the raw response to us: Nest sends nothing itself for this route.
   */
  @Get(':runId/events')
  async streamEvents(
    @CurrentCaller() caller: Caller,
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('after') after: string | undefined,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    await this.runs.get(caller.tenantId, runId);
    await streamRunEvents(
      this.events,
      caller.tenantId,
      runId,
      resumePoint(lastEventId, after),
      req,
      res,
    );
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
