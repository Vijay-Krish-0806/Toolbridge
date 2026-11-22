import { Controller, Get, Param } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { UsageLedger } from './usage-ledger.js';

/**
 * The tenant's token use and cost (Step 4.6). Tenant from the API key only: cost is the
 * tenant's business data, so it is never served to an end user's session (the browser).
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly ledger: UsageLedger) {}

  /**
   * What one run really spent, retried legs included. A run of another tenant, or one that made
   * no model call yet, reads as all zeros (rows are tenant-scoped, so nothing leaks).
   */
  @Get('runs/:runId')
  run(@CurrentCaller() caller: Caller, @Param('runId') runId: string) {
    return this.ledger.runSpend(caller.tenantId, runId);
  }
}
