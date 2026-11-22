import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ApprovalDecision } from '@toolbridge/agent-core';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';

/** The queue every run leg goes through (one queue, two kinds of job). */
export const RUN_QUEUE = 'agent-runs';
/**
 * Redis pub/sub channels, prefixed like the queue so separate environments never hear each
 * other: "stop this run" (API to workers) and "run X has a new event" (writers to streams).
 */
export function channel(config: PlatformConfig, name: 'run-cancel' | 'run-events'): string {
  return `${config.RUN_QUEUE_PREFIX}:${name}`;
}

/**
 * A job is one LEG of a run: `start` (from the user's message to a pause or the end) or `resume`
 * (after an approval decision). The job carries ids only; the worker loads the rest (principal,
 * spec, card) from MongoDB, so a job never holds a stale or secret copy.
 */
export type RunJob =
  | { kind: 'start'; tenantId: string; runId: string }
  | {
      kind: 'resume';
      tenantId: string;
      runId: string;
      approvalId: string;
      decision: ApprovalDecision;
    };

/** Redis connection settings shared by the queue, the workers and pub/sub. */
export function redisOptions(config: PlatformConfig) {
  // maxRetriesPerRequest: null is required by BullMQ for worker connections (going-to-production
  // guide): a blocking command must wait for Redis to come back instead of failing.
  return { host: config.REDIS_HOST, port: config.REDIS_PORT, maxRetriesPerRequest: null };
}

/**
 * The API's side of the queue: adds legs and asks workers to cancel. It never runs a leg.
 *
 * Job options (BullMQ):
 * - `jobId`: `start-<runId>` or `resume-<approvalId>`. Adding a job whose id exists is ignored,
 *   so a repeated request cannot queue the same leg twice. (Ids may not contain ":".)
 * - `attempts: 3` with exponential backoff: a leg that throws (model or network error) is
 *   retried; after the last attempt the job stays in the FAILED set, our dead-letter queue.
 * - A worker that dies stops renewing its lock; BullMQ's stalled check moves the job back to
 *   waiting and another worker continues it (from the checkpoint).
 */
@Injectable()
export class RunQueue implements OnApplicationShutdown {
  private readonly queue: Queue<RunJob>;
  private readonly publisher: Redis;

  constructor(@Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig) {
    this.queue = new Queue<RunJob>(RUN_QUEUE, {
      connection: redisOptions(config),
      prefix: config.RUN_QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    this.publisher = new Redis(redisOptions(config));
  }

  /** Queues the first leg of a run. */
  async start(tenantId: string, runId: string): Promise<void> {
    await this.queue.add('start', { kind: 'start', tenantId, runId }, { jobId: `start-${runId}` });
  }

  /** Queues the leg after a decision; one per card, whatever happens to the request. */
  async resume(job: Extract<RunJob, { kind: 'resume' }>): Promise<void> {
    await this.queue.add('resume', job, { jobId: `resume-${job.approvalId}` });
  }

  /** Tells every worker to stop this run's leg if it is running it right now. */
  async cancel(runId: string): Promise<void> {
    await this.publisher.publish(channel(this.config, 'run-cancel'), runId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    this.publisher.disconnect();
  }
}
