/**
 * A LangGraph CHECKPOINTER on MongoDB driver v7 (Step 4.3, ADR 0030).
 *
 * What a checkpointer does: after every super-step, LangGraph hands it the whole graph state
 * (a "checkpoint") to save, keyed by the run's `thread_id`. To resume a paused run (an approval
 * wait, or a restart), LangGraph loads the latest checkpoint for that thread and continues from
 * it. "Pending writes" are the updates of a step that had started but not finished (for example,
 * the `interrupt()` that paused the run); they are saved separately so a resume can replay them.
 *
 * Layout (the same as LangGraph's official MongoDB saver, so behaviour matches):
 * - `checkpoints`: one document per (thread_id, checkpoint_ns, checkpoint_id).
 * - `checkpoint_writes`: one document per pending write, keyed also by task_id and idx.
 * Values are serialized by LangGraph's own `serde` and stored as bytes: this class never needs
 * to understand the state it stores.
 */
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  maxChannelVersion,
  writesSortKey,
} from '@langchain/langgraph-checkpoint';
import { Binary, type Collection, type Db, type Filter } from 'mongodb';

interface CheckpointDoc {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  /** The serde format name, needed to decode the bytes (for example "json"). */
  type: string;
  checkpoint: Binary;
  metadata: Binary;
  /** The metadata again as plain fields, so `list({ filter })` can query it. */
  metadata_search: CheckpointMetadata;
}

interface WriteDoc {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  task_path: string;
  idx: number;
  channel: string;
  type: string;
  value: Binary;
}

export interface MongoSaverOptions {
  /** The database to keep checkpoints in (the caller owns the client and its lifetime). */
  db: Db;
  /** Defaults: `checkpoints` and `checkpoint_writes`. */
  checkpointCollection?: string;
  writesCollection?: string;
}

export class MongoSaver extends BaseCheckpointSaver {
  private readonly checkpoints: Collection<CheckpointDoc>;
  private readonly writes: Collection<WriteDoc>;

  /** `serde` is optional: without it LangGraph's default JSON serializer is used. */
  constructor(options: MongoSaverOptions, serde?: SerializerProtocol) {
    super(serde);
    this.checkpoints = options.db.collection(options.checkpointCollection ?? 'checkpoints');
    this.writes = options.db.collection(options.writesCollection ?? 'checkpoint_writes');
  }

  /**
   * Creates the indexes the queries below need. Safe to call on every start. Without them, every
   * resume would scan the whole collection as it grows.
   */
  async setup(): Promise<void> {
    await this.checkpoints.createIndex(
      { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
      { unique: true, name: 'thread_ns_checkpoint' },
      undefined,
    );
    await this.writes.createIndex(
      { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 },
      { unique: true, name: 'thread_ns_checkpoint_task_idx' },
      undefined,
    );
  }

  /**
   * Loads one checkpoint: the one named by `checkpoint_id`, or else the newest for the thread.
   * Checkpoint ids are time-ordered (uuid6), so "newest" is the highest id.
   * Before -> after: `{ configurable: { thread_id: 'run-1' } }` ->
   * `{ config: { configurable: { thread_id: 'run-1', checkpoint_ns: '', checkpoint_id: '1ef...' } },
   *    checkpoint, metadata, pendingWrites: [[taskId, channel, value], ...], parentConfig }`,
   * or undefined when the thread has none.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = configString(config, 'thread_id');
    if (threadId === undefined) return undefined;
    const ns = configString(config, 'checkpoint_ns') ?? '';
    const checkpointId = configString(config, 'checkpoint_id');
    const query: Filter<CheckpointDoc> = { thread_id: threadId, checkpoint_ns: ns };
    if (checkpointId !== undefined) query.checkpoint_id = checkpointId;

    const [doc] = await this.checkpoints.find(query).sort({ checkpoint_id: -1 }).limit(1).toArray();
    return doc ? this.toTuple(doc) : undefined;
  }

  /**
   * Lists checkpoints, newest first, with optional thread, namespace, metadata filter, `before`
   * (only ids older than this one) and `limit`. Metadata filter values must be primitives.
   */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options;
    const query: Filter<CheckpointDoc> = {};
    const threadId = configString(config, 'thread_id');
    const ns = configString(config, 'checkpoint_ns');
    if (threadId !== undefined) query.thread_id = threadId;
    if (ns !== undefined) query.checkpoint_ns = ns;
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value !== null && typeof value === 'object') {
        throw new Error(
          `Invalid filter value for "${key}": use a string, number, boolean or null.`,
        );
      }
      (query as Record<string, unknown>)[`metadata_search.${key}`] = value;
    }
    const beforeId = before ? configString(before, 'checkpoint_id') : undefined;
    if (beforeId !== undefined) query.checkpoint_id = { $lt: beforeId };

    let cursor = this.checkpoints.find(query).sort({ checkpoint_id: -1 });
    if (limit !== undefined) cursor = cursor.limit(limit);
    for await (const doc of cursor) yield await this.toTuple(doc);
  }

  /**
   * Saves one checkpoint (an upsert, so saving the same id twice is harmless). The config's
   * `checkpoint_id`, if any, is the parent: the checkpoint this one was made from.
   * Before -> after: `({ thread_id: 'run-1', checkpoint_id: 'A' }, checkpoint B)` -> stored with
   * parent A; returns `{ configurable: { thread_id: 'run-1', checkpoint_ns: '', checkpoint_id: 'B' } }`.
   * LangGraph also passes `newVersions` (which channels changed); it is not used, because the
   * full checkpoint is stored every time (ADR 0030).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = requiredString(config, 'thread_id');
    const ns = configString(config, 'checkpoint_ns') ?? '';
    const parentId = configString(config, 'checkpoint_id');
    const [[type, bytes], [metaType, metaBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metaType) throw new Error('Checkpoint and metadata were serialized differently.');

    await this.checkpoints.updateOne(
      { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
      {
        $set: {
          ...(parentId !== undefined && { parent_checkpoint_id: parentId }),
          type,
          checkpoint: toBinary(bytes),
          metadata: toBinary(metaBytes),
          metadata_search: metadata,
        },
      },
      { upsert: true },
    );
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  /**
   * Saves the writes of one task inside a step, linked to the checkpoint they apply to.
   * Ordinary writes are insert-once (`$setOnInsert`): if the same task is replayed after a
   * crash, the first value wins, so a write is never recorded twice with different values.
   * "Special" writes (errors, interrupts, resume values) use fixed slots and may be replaced,
   * matching LangGraph's own savers.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = '',
  ): Promise<void> {
    const threadId = requiredString(config, 'thread_id');
    const ns = requiredString(config, 'checkpoint_ns');
    const checkpointId = requiredString(config, 'checkpoint_id');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);

    const operations = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        const fields = { channel, type, value: toBinary(bytes), task_path: taskPath };
        const key = {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpointId,
          task_id: taskId,
          idx: WRITES_IDX_MAP[channel] ?? i,
        };
        return {
          updateOne: {
            filter: key,
            update: allSpecial ? { $set: fields } : { $setOnInsert: fields },
            upsert: true,
          },
        };
      }),
    );
    if (operations.length > 0) await this.writes.bulkWrite(operations);
  }

  /** Deletes every checkpoint and pending write of one thread (for example, a deleted run). */
  async deleteThread(threadId: string): Promise<void> {
    await this.checkpoints.deleteMany({ thread_id: threadId });
    await this.writes.deleteMany({ thread_id: threadId });
  }

  /**
   * Upgrades a checkpoint from LangGraph's older format (version below 4) as it is read. Those
   * versions kept "pending sends" (tasks queued with `Send`) as writes on the PARENT checkpoint;
   * newer versions keep them in the checkpoint's own `__pregel_tasks` channel. This copies them
   * across, as LangGraph's own MemorySaver does (found by the conformance suite). This saver never
   * writes old checkpoints itself; it only has to read them correctly.
   */
  private async migratePendingSends(
    checkpoint: Checkpoint,
    parent: { thread_id: string; checkpoint_ns: string; checkpoint_id: string },
  ): Promise<void> {
    const sends = await this.writes.find({ ...parent, channel: TASKS }).toArray();
    const ordered = sends
      .map((w) => ({ sortKey: writesSortKey(w.task_path, w.task_id, w.idx), w }))
      .sort((a, b) => compareWritesSortKeys(a.sortKey, b.sortKey));
    const values: unknown[] = await Promise.all(
      ordered.map(({ w }) => this.serde.loadsTyped(w.type, w.value.value())),
    );
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_values[TASKS] = values;
    checkpoint.channel_versions[TASKS] =
      versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }

  /**
   * Turns a stored checkpoint document back into LangGraph's tuple, with its pending writes in
   * the order LangGraph applies them (task path, task id, index).
   */
  private async toTuple(doc: CheckpointDoc): Promise<CheckpointTuple> {
    const key = {
      thread_id: doc.thread_id,
      checkpoint_ns: doc.checkpoint_ns,
      checkpoint_id: doc.checkpoint_id,
    };
    const writeDocs = await this.writes.find(key).toArray();
    const ordered = writeDocs
      .map((w) => ({ sortKey: writesSortKey(w.task_path, w.task_id, w.idx), w }))
      .sort((a, b) => compareWritesSortKeys(a.sortKey, b.sortKey))
      .map(({ w }) => w);
    const pendingWrites = await Promise.all(
      ordered.map(
        async (w) =>
          [w.task_id, w.channel, await this.serde.loadsTyped(w.type, w.value.value())] as [
            string,
            string,
            unknown,
          ],
      ),
    );
    const checkpoint = (await this.serde.loadsTyped(
      doc.type,
      doc.checkpoint.value(),
    )) as Checkpoint;
    if (checkpoint.v < 4 && doc.parent_checkpoint_id !== undefined) {
      await this.migratePendingSends(checkpoint, {
        ...key,
        checkpoint_id: doc.parent_checkpoint_id,
      });
    }
    return {
      config: { configurable: key },
      checkpoint,
      metadata: (await this.serde.loadsTyped(doc.type, doc.metadata.value())) as CheckpointMetadata,
      pendingWrites,
      ...(doc.parent_checkpoint_id !== undefined && {
        parentConfig: {
          configurable: {
            thread_id: doc.thread_id,
            checkpoint_ns: doc.checkpoint_ns,
            checkpoint_id: doc.parent_checkpoint_id,
          },
        },
      }),
    };
  }
}

/**
 * Reads an optional string from `config.configurable`. A value that is present but not a string
 * is a caller bug and throws, rather than silently matching nothing.
 * Before -> after: `({ configurable: { thread_id: 'run-1' } }, 'thread_id')` -> `'run-1'`;
 * missing -> undefined; `{ thread_id: 7 }` -> throws.
 */
function configString(config: RunnableConfig, name: string): string | undefined {
  const value: unknown = config.configurable?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`configurable.${name} must be a string.`);
  return value;
}

/** Like `configString`, but the value must be present. */
function requiredString(config: RunnableConfig, name: string): string {
  const value = configString(config, name);
  if (value === undefined) throw new Error(`configurable.${name} is required.`);
  return value;
}

/**
 * Wraps serialized bytes as BSON Binary for storage. Reading gives a `Binary` back, and
 * `Binary.value()` (bson 7: no argument, returns a Uint8Array) gives the bytes back.
 */
function toBinary(bytes: Uint8Array): Binary {
  return new Binary(bytes);
}
