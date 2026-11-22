import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { TenantBudget } from './tenant-budget.js';
import { UsageQueryDto } from './usage.dto.js';
import { monthStartUtc, type RunSpend, UsageLedger } from './usage-ledger.js';

/** Longest range one report may cover, so a request cannot ask MongoDB to scan years of rows. */
const MAX_RANGE_DAYS = 366;

/**
 * The tenant's token use and cost (Step 4.6). Tenant from the API key only: cost is the
 * tenant's business data, so it is never served to an end user's session (the browser).
 */
@Controller('usage')
export class UsageController {
  constructor(
    private readonly ledger: UsageLedger,
    private readonly budget: TenantBudget,
  ) {}

  /**
   * Use in a range, by UTC day and model, with totals and this month's budget status.
   * Before -> after: `GET /usage` on Nov 22 -> `{ from: Nov 1, to: now, totals, byDay: [...],
   * budget: { month: '2026-11', monthlyTokenBudget, usedTokens, leftTokens } }`.
   */
  @Get()
  async report(@CurrentCaller() caller: Caller, @Query() query: UsageQueryDto) {
    const now = new Date();
    const from = query.from ?? monthStartUtc(now);
    const to = query.to ?? now;
    if (from >= to) throw new BadRequestException('"from" must be before "to".');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`A report covers at most ${String(MAX_RANGE_DAYS)} days.`);
    }
    const byDay = await this.ledger.report(caller.tenantId, from, to);
    const totals = byDay.reduce<RunSpend>(
      (sum, day) => ({
        modelCalls: sum.modelCalls + day.modelCalls,
        inputTokens: sum.inputTokens + day.inputTokens,
        outputTokens: sum.outputTokens + day.outputTokens,
        costMicroUsd: sum.costMicroUsd + day.costMicroUsd,
      }),
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    );
    return { from, to, totals, byDay, budget: await this.budget.status(caller.tenantId, now) };
  }

  /**
   * What one run really spent, retried legs included. A run of another tenant, or one that made
   * no model call yet, reads as all zeros (rows are tenant-scoped, so nothing leaks).
   */
  @Get('runs/:runId')
  run(@CurrentCaller() caller: Caller, @Param('runId') runId: string) {
    return this.ledger.runSpend(caller.tenantId, runId);
  }
}
