import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MIN_CALL_OUTPUT_TOKENS } from '@toolbridge/agent-core';
import type { Types } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { monthStartUtc, UsageLedger } from './usage-ledger.js';

/** Where a tenant stands against its monthly budget. */
export interface BudgetStatus {
  /** `YYYY-MM`, UTC: the budget period. */
  month: string;
  /** null = no limit. */
  monthlyTokenBudget: number | null;
  usedTokens: number;
  /** null when there is no limit; can be negative (a soft limit, see ADR 0042). */
  leftTokens: number | null;
}

/**
 * The per-tenant monthly token budget (Step 4.6, ADR 0042). It decides, when a run starts,
 * whether it may start and what its token cap is. Spend comes from the usage ledger, so
 * retried legs count.
 */
@Injectable()
export class TenantBudget {
  constructor(
    private readonly tenants: TenantsService,
    private readonly ledger: UsageLedger,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
  ) {}

  /**
   * This month's budget, use and balance.
   * Before -> after: budget 100,000, 30,000 used -> `{ month: '2026-11', usedTokens: 30000,
   * leftTokens: 70000, ... }`.
   */
  async status(tenantId: Types.ObjectId, now = new Date()): Promise<BudgetStatus> {
    const budget = await this.tenants.monthlyTokenBudgetOf(tenantId);
    const used = await this.ledger.tokensSince(tenantId, monthStartUtc(now));
    return {
      month: now.toISOString().slice(0, 7),
      monthlyTokenBudget: budget,
      usedTokens: used,
      leftTokens: budget === null ? null : budget - used,
    };
  }

  /**
   * The token cap of a run starting now: the smaller of RUN_MAX_TOKENS and what the tenant has
   * left. Throws 429 `budget_exhausted` (no Retry-After: it is a quota, not a burst limit) when
   * too little is left for even one model call.
   * Before -> after: RUN_MAX_TOKENS 60,000, left 70,000 -> 60,000; left 5,000 -> 5,000;
   * left 100 -> 429.
   */
  async capForNewRun(tenantId: Types.ObjectId): Promise<number> {
    const { leftTokens } = await this.status(tenantId);
    if (leftTokens === null) return this.config.RUN_MAX_TOKENS;
    if (leftTokens < MIN_CALL_OUTPUT_TOKENS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'budget_exhausted',
          message: 'This account has used its token budget for this month.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return Math.min(this.config.RUN_MAX_TOKENS, leftTokens);
  }
}
