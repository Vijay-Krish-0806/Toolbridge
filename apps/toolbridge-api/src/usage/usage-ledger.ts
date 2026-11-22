import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type AgentEvent, costMicroUsd } from '@toolbridge/agent-core';
import type { Model, Types } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import type { PlatformConfig } from '../config.js';
import { MODEL, type UsageRecord } from '../domain/models.js';

/** What a run really spent, summed from its usage records (retried legs included). */
export interface RunSpend {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

/** Collects one leg's model calls and writes them; `flush` waits for every write. */
export interface UsageMeter {
  onEvent(event: AgentEvent): void;
  flush(): Promise<void>;
}

/**
 * The usage ledger (Step 4.6, ADR 0042): one insert-only row per finished model call, priced
 * with the configured model's price. Like the audit log, this class only inserts and reads.
 */
@Injectable()
export class UsageLedger {
  private readonly logger = new Logger(UsageLedger.name);

  constructor(
    @InjectModel(MODEL.UsageRecord.name) private readonly model: Model<UsageRecord>,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
  ) {}

  /**
   * A meter for one leg: it turns each `llm-response` event (a model call that finished) into a
   * usage row. The graph emits events synchronously, so writes are started here and awaited in
   * `flush`. A failed write is logged, not thrown: the tokens were spent either way, and losing
   * a row must not fail the run (the run's own totals still have them).
   * Before -> after: event `{ type: 'llm-response', result: { usage: { inputTokens: 900,
   * outputTokens: 40 } } }` -> row `{ runId, model, inputTokens: 900, outputTokens: 40,
   * costMicroUsd, price, at }`.
   */
  meterFor(tenantId: Types.ObjectId, runId: string): UsageMeter {
    const writes: Promise<void>[] = [];
    return {
      onEvent: (event) => {
        if (event.type !== 'llm-response') return;
        writes.push(this.record(tenantId, runId, event.result.usage));
      },
      flush: async () => {
        await Promise.all(writes);
      },
    };
  }

  /**
   * What one run spent, from its rows. A run has at most a few dozen model calls, so the rows
   * are summed here rather than in an aggregation.
   * Before -> after: rows of 900+40 and 1,200+60 tokens -> `{ modelCalls: 2, inputTokens: 2100,
   * outputTokens: 100, costMicroUsd: ... }`.
   */
  async runSpend(tenantId: Types.ObjectId, runId: string): Promise<RunSpend> {
    const rows = await this.records(tenantId).find({ runId });
    return rows.reduce<RunSpend>(
      (sum, row) => ({
        modelCalls: sum.modelCalls + 1,
        inputTokens: sum.inputTokens + row.inputTokens,
        outputTokens: sum.outputTokens + row.outputTokens,
        costMicroUsd: sum.costMicroUsd + row.costMicroUsd,
      }),
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    );
  }

  /** Writes one call's row. A server that reports no token counts is recorded as 0, loudly. */
  private async record(
    tenantId: Types.ObjectId,
    runId: string,
    usage: { inputTokens: number; outputTokens: number } | undefined,
  ): Promise<void> {
    const { llm, llmPrice } = this.config;
    if (!usage) this.logger.warn(`Run ${runId}: model reported no token counts; recorded as 0`);
    const tokens = usage ?? { inputTokens: 0, outputTokens: 0 };
    try {
      await this.records(tenantId).insertOne({
        runId,
        model: llm.model,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        costMicroUsd: costMicroUsd(llmPrice, tokens),
        price: { ...llmPrice },
        at: new Date(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run ${runId}: usage row lost (${JSON.stringify(tokens)}): ${message}`);
    }
  }

  private records(tenantId: Types.ObjectId): TenantScoped<UsageRecord> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }
}
