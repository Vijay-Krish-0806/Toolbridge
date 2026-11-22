import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { RUN_EVENTS_VERSION, type RunEvent, type RunEventBody } from '@toolbridge/run-events';
import { Redis } from 'ioredis';
import type { Model, Types } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import type { PlatformConfig } from '../config.js';
import { MODEL, type Run, type RunEventRecord } from '../domain/models.js';
import { channel, redisOptions } from '../runs/run-queue.js';

/**
 * The persisted event log of every run (Step 4.4a, ADR 0035). MongoDB is the source of truth:
 * an event is first stored with the run's next sequence number, then announced on a Redis
 * channel so open streams wake up at once. A stream that misses an announcement still finds the
 * event on its next poll; one that disconnects asks again from its last number. So the log, not
 * the connection, decides what a client sees.
 */
@Injectable()
export class EventLog implements OnApplicationShutdown {
  private readonly logger = new Logger(EventLog.name);
  private publisher: Redis | undefined;
  private subscriber: Redis | undefined;
  /** Open streams in this process, by run id: called when that run has a new event. */
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @InjectModel(MODEL.Run.name) private readonly runModel: Model<Run>,
    @InjectModel(MODEL.RunEvent.name) private readonly eventModel: Model<RunEventRecord>,
  ) {}

  /**
   * Stores one event as the run's next number and announces it.
   * Before -> after: (run 3f2c…, `{ type: 'run_finished', data: { status: 'completed' } }`) ->
   * `{ v: 1, runId: '3f2c…', seq: 7, type: 'run_finished', … }`.
   * The number comes from an atomic `$inc` on the run record, so two writers (a worker and the
   * API cancelling a waiting run) can never get the same one.
   */
  async append(tenantId: Types.ObjectId, runId: string, body: RunEventBody): Promise<RunEvent> {
    const run = await this.runs(tenantId).incrementOne({ _id: runId }, 'eventSeq');
    if (!run) throw new Error(`Run ${runId} not found for its event.`);
    const at = new Date();
    await this.events(tenantId).insertOne({
      runId,
      seq: run.eventSeq,
      type: body.type,
      data: body.data,
      at,
    });
    this.publisher ??= new Redis(redisOptions(this.config));
    await this.publisher.publish(channel(this.config, 'run-events'), runId);
    return toEvent({ runId, seq: run.eventSeq, type: body.type, data: body.data, at });
  }

  /** The run's events after `after`, in order, at most `limit`. */
  async read(
    tenantId: Types.ObjectId,
    runId: string,
    after: number,
    limit = 200,
  ): Promise<RunEvent[]> {
    const rows = await this.events(tenantId).find(
      { runId, seq: { $gt: after } },
      { seq: 1 },
      limit,
    );
    return rows.map(toEvent);
  }

  /**
   * Calls `listener` whenever the run gets a new event (best effort: a wake-up, not the data).
   * One Redis subscriber per process serves every open stream. Returns the unsubscribe function.
   */
  async subscribe(runId: string, listener: () => void): Promise<() => void> {
    if (!this.subscriber) {
      this.subscriber = new Redis(redisOptions(this.config));
      await this.subscriber.subscribe(channel(this.config, 'run-events'));
      this.subscriber.on('message', (_channel: string, id: string) => {
        for (const wake of this.listeners.get(id) ?? []) wake();
      });
      this.subscriber.on('error', (error: Error) => {
        this.logger.warn(`Event subscriber: ${error.message}`);
      });
    }
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  onApplicationShutdown(): void {
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
  }

  private runs(tenantId: Types.ObjectId): TenantScoped<Run> {
    return new TenantScoped(mongooseCollection(this.runModel), tenantId);
  }

  private events(tenantId: Types.ObjectId): TenantScoped<RunEventRecord> {
    return new TenantScoped(mongooseCollection(this.eventModel), tenantId);
  }
}

/** A stored row as the public v1 event. */
function toEvent(row: Pick<RunEventRecord, 'runId' | 'seq' | 'type' | 'data' | 'at'>): RunEvent {
  return {
    v: RUN_EVENTS_VERSION,
    runId: row.runId,
    seq: row.seq,
    at: row.at.toISOString(),
    type: row.type,
    data: row.data,
  } as RunEvent;
}
