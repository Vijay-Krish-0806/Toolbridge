import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';

import { CurrentSession, SessionOnly } from '../auth/auth.decorators.js';
import { EventLog } from '../events/event-log.js';
import { resumePoint, streamRunEvents } from '../events/event-stream.js';
import type { SessionCaller } from '../sessions/sessions.service.js';
import { ApprovalsService } from './approvals.service.js';
import { DecideApprovalDto, ListApprovalsQuery, StartRunDto } from './runs.dto.js';
import { RateLimiter } from './rate-limiter.js';
import { RunsService } from './runs.service.js';

/**
 * Agent runs (Steps 4.3, 4.4a, 4.4b). SESSION TOKENS ONLY: a run acts for one host user, whose
 * id, role and spec come from the verified token. A user sees only their own runs (another
 * user's or another tenant's run is a 404).
 */
@Controller('runs')
@SessionOnly()
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly events: EventLog,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * 202 Accepted: the run was saved and queued; follow it with GET /runs/:id/events.
   * 429 with Retry-After (seconds) when the tenant has started too many runs this minute
   * (Step 4.5, a token bucket per tenant in Redis). Nothing is saved or queued then.
   */
  @Post()
  @HttpCode(202)
  async start(
    @CurrentSession() session: SessionCaller,
    @Body() dto: StartRunDto,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    const rate = await this.rateLimiter.take('runs', session.tenantId.toHexString());
    if (!rate.allowed) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
      throw new HttpException(
        'Too many runs started for this account; try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.runs.start(session.tenantId, {
      specId: session.specId,
      message: dto.message,
      ...(dto.conversationId !== undefined && { conversationId: dto.conversationId }),
      principal: { userId: session.userId, role: session.role },
      sessionId: session.jti,
    });
  }

  @Get(':runId')
  get(@CurrentSession() session: SessionCaller, @Param('runId') runId: string) {
    return this.runs.get(session.tenantId, runId, session.userId);
  }

  /**
   * The run's public events as Server-Sent Events (docs/run-events.md). Use fetch with an
   * `Authorization` header (never a token in the URL); resume with `Last-Event-ID` or `?after=`.
   * The run is looked up first, so another user's run is a plain 404, not an empty stream.
   * `@Res()` hands the raw response to us: Nest sends nothing itself for this route.
   */
  @Get(':runId/events')
  async streamEvents(
    @CurrentSession() session: SessionCaller,
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('after') after: string | undefined,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    await this.runs.get(session.tenantId, runId, session.userId);
    await streamRunEvents(
      this.events,
      session.tenantId,
      runId,
      resumePoint(lastEventId, after),
      req,
      res,
    );
  }

  /** 202 Accepted: a waiting run is cancelled at once; a running one is stopped by its worker. */
  @Post(':runId/cancel')
  @HttpCode(202)
  cancel(@CurrentSession() session: SessionCaller, @Param('runId') runId: string) {
    return this.runs.cancel(session.tenantId, runId, session.userId);
  }
}

/**
 * Approval cards: the inbox, and approving or rejecting with a reason. SESSION TOKENS ONLY: the
 * approver is the token's user, and sees the cards of runs on the spec the session is for.
 */
@Controller('approvals')
@SessionOnly()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentSession() session: SessionCaller, @Query() query: ListApprovalsQuery) {
    return this.approvals.list(session.tenantId, session.specId, query.status);
  }

  /** 202 Accepted: the decision is recorded and the run continues in the background. */
  @Post(':approvalId/approve')
  @HttpCode(202)
  approve(
    @CurrentSession() session: SessionCaller,
    @Param('approvalId') approvalId: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(session, approvalId, 'approved', dto.reason);
  }

  @Post(':approvalId/reject')
  @HttpCode(202)
  reject(
    @CurrentSession() session: SessionCaller,
    @Param('approvalId') approvalId: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(session, approvalId, 'rejected', dto.reason);
  }
}
