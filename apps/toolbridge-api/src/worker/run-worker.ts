import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Types } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { CANCEL_CHANNEL, redisOptions, RUN_QUEUE, type RunJob } from '../runs/run-queue.js';
import { RunExecutor } from './run-executor.js';

/** Why a leg was aborted by us (as opposed to a crash or a model error). */
class LegStopped extends Error {
  constructor(readonly why: 'time_limit' | 'cancelled') {
    super(why);
  }
}

/**
 * The worker process's consumer of the run queue (Step 4.4a).
 *
 * Failure handling, in BullMQ terms:
 * - an ordinary error (model or network down) is thrown again, so BullMQ RETRIES the job with
 *   backoff; after the last attempt the job stays in the failed set (the DEAD-LETTER QUEUE) and
 *   the run is marked failed;
 * - the TIME LIMIT (RUN_LEG_TIMEOUT_MS) and a CANCEL abort the leg through one AbortSignal that
 *   reaches the model request and tool calls; they end the run and throw UnrecoverableError, so
 *   BullMQ does not retry them;
 * - a worker that DIES stops renewing its lock: the job "stalls", BullMQ gives it to another
 *   worker, and RunExecutor continues the run from its last checkpoint.
 */
@Injectable()
export class RunWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RunWorker.name);
  private worker: Worker<RunJob> | undefined;
  private subscriber: Redis | undefined;
  /** Legs running in THIS process, by run id, so a cancel message can stop the right one. */
  private readonly active = new Map<string, AbortController>();

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    private readonly executor: RunExecutor,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cancel requests arrive on a pub/sub channel, because BullMQ's own cancelJob only reaches
    // jobs of the Worker object it is called on, not workers in other processes.
    this.subscriber = new Redis(redisOptions(this.config));
    await this.subscriber.subscribe(CANCEL_CHANNEL);
    this.subscriber.on('message', (_channel: string, runId: string) => {
      this.active.get(runId)?.abort(new LegStopped('cancelled'));
    });

    this.worker = new Worker<RunJob>(
      RUN_QUEUE,
      (job, _token, signal) => this.process(job, signal),
      {
        connection: redisOptions(this.config),
        prefix: this.config.RUN_QUEUE_PREFIX,
        concurrency: this.config.WORKER_CONCURRENCY,
        lockDuration: this.config.WORKER_LOCK_MS,
        stalledInterval: this.config.WORKER_LOCK_MS,
      },
    );
    this.worker.on('failed', (job, error) => {
      void this.onFailed(job, error);
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Worker error: ${error.message}`);
    });
  }

  /** Graceful shutdown: stop taking jobs and wait for running legs to finish. */
  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    this.subscriber?.disconnect();
  }

  /** Runs one job with the time limit and the cancel switch attached. */
  private async process(job: Job<RunJob>, bullSignal: AbortSignal | undefined): Promise<void> {
    const { runId } = job.data;
    const cancel = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new LegStopped('time_limit'));
    }, this.config.RUN_LEG_TIMEOUT_MS);
    const signal = AbortSignal.any([
      cancel.signal,
      deadline.signal,
      ...(bullSignal ? [bullSignal] : []),
    ]);
    this.active.set(runId, cancel);
    const tenantId = new Types.ObjectId(job.data.tenantId);
    try {
      await this.executor.executeLeg(job.data, signal);
    } catch (error) {
      if (deadline.signal.aborted) {
        const minutes = Math.round(this.config.RUN_LEG_TIMEOUT_MS / 600) / 100;
        await this.executor.end(
          tenantId,
          runId,
          'failed',
          `The run hit its time limit (${String(minutes)} min) and was stopped.`,
        );
        throw new UnrecoverableError('time limit');
      }
      if (cancel.signal.aborted) {
        await this.executor.end(tenantId, runId, 'cancelled', 'Cancelled.');
        throw new UnrecoverableError('cancelled');
      }
      this.logger.error(
        `Run ${runId} leg failed (attempt ${String(job.attemptsMade + 1)}): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error; // BullMQ retries it, or moves it to the failed set after the last attempt
    } finally {
      clearTimeout(timer);
      this.active.delete(runId);
    }
  }

  /**
   * BullMQ's `failed` event fires after every failed attempt. `finishedOn` is set only when the
   * job will NOT be retried (attempts used up, an UnrecoverableError, or stalled too often):
   * then the job is in the dead-letter set and the run must say so.
   */
  private async onFailed(job: Job<RunJob> | undefined, error: Error): Promise<void> {
    if (!job?.finishedOn) return;
    try {
      await this.executor.end(
        new Types.ObjectId(job.data.tenantId),
        job.data.runId,
        'failed',
        'The run failed and was not retried again; see the worker log.',
      );
    } catch (writeError) {
      this.logger.error(
        `Could not mark run ${job.data.runId} failed after "${error.message}": ${String(writeError)}`,
      );
    }
  }
}
