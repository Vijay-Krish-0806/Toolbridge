import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ToolResultCache } from '@toolbridge/agent-core';
import { contentHash, sha256 } from '@toolbridge/spec-compiler';
import { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import type { ConnectionForCall } from '../connections/connections.service.js';
import type { CredentialMode, Spec } from '../domain/models.js';
import { redisOptions } from './run-queue.js';

/** The API whose results are cached: one connection of one spec of one tenant. */
export interface CachedApi {
  tenantId: Types.ObjectId;
  spec: Pick<Spec, '_id' | 'currentVersion'>;
  connection: Pick<ConnectionForCall, 'baseUrl' | 'cacheTtlSeconds' | 'updatedAt'>;
}

/**
 * Whom a result belongs to. Delegated mode: the user whose own token makes the call, because the
 * API may answer each user differently. Service mode: no user (the API only ever sees the stored
 * credential); the role keeps roles apart anyway, as defense in depth.
 */
export interface CacheIdentity {
  mode: CredentialMode;
  role: string;
  userId: string | null;
}

/**
 * Cached tool results in Redis (Step 4.8, ADR 0046), shared by every worker.
 *
 * Two kinds of keys, both under the queue prefix and the tenant:
 * - an entry: `<version>\n<result>`, always with a TTL (Redis runs with `noeviction`, as BullMQ
 *   requires, so nothing else would ever remove it);
 * - the API's version: a counter raised by every write. It has NO TTL on purpose: if it expired
 *   and started over, an old entry could match the new count.
 *
 * Unreadable means "ask the API", so this client gives up quickly, unlike the queue's (which waits
 * for Redis to come back).
 */
@Injectable()
export class ToolCache implements OnApplicationShutdown {
  private readonly logger = new Logger(ToolCache.name);
  private readonly redis: Redis;

  constructor(@Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig) {
    this.redis = new Redis({
      ...redisOptions(config),
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
    });
    // Without a listener ioredis prints every reconnect error; the commands already report them.
    this.redis.on('error', () => undefined);
  }

  /**
   * The executor's cache for one API. Without `identityOf` nothing is read or stored; writes still
   * invalidate (direct tool calls have no user or role to keep results apart).
   */
  for(api: CachedApi, identityOf?: (callId: string) => CacheIdentity): ToolResultCache {
    const { tenantId, connection } = api;
    const root = `${this.config.RUN_QUEUE_PREFIX}:toolcache:${tenantId.toHexString()}`;
    // By origin, not by spec: two specs of one tenant for the same API see each other's writes.
    const versionKey = `${root}:version:${sha256(new URL(connection.baseUrl).origin)}`;
    const ttlMs = connection.cacheTtlSeconds * 1000;
    return {
      lookup: async ({ callId, toolName, args }) => {
        const identity = identityOf?.(callId);
        if (!identity || ttlMs <= 0) return undefined;
        const key = `${root}:entry:${entryHash(api, identity, toolName, args)}`;
        // One command, so the version and the entry belong to the same moment.
        const [current, entry] = await this.redis.mget(versionKey, key);
        const version = current ?? '0';
        if (entry?.startsWith(`${version}\n`)) {
          return { hit: true, content: entry.slice(version.length + 1) };
        }
        return {
          hit: false,
          store: async (content) => {
            await this.redis.set(key, `${version}\n${content}`, 'PX', ttlMs);
          },
        };
      },
      invalidate: async () => {
        try {
          await this.redis.incr(versionKey);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Tool cache of tenant ${tenantId.toHexString()} could not be invalidated (${reason}); ` +
              'cached reads may be old until their TTL ends.',
          );
        }
      },
    };
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * The fingerprint of one call by one identity. Everything that could change the answer is in it:
 * a new spec version (another result shape) or a connection set again (another API or credential)
 * gives new keys. Arguments are compared with sorted keys.
 * Before -> after: (store API, support, 'orders_get', { number: 'ORD-7' }) -> 64 hex characters.
 */
function entryHash(
  { spec, connection }: CachedApi,
  identity: CacheIdentity,
  toolName: string,
  args: unknown,
): string {
  return contentHash({
    spec: spec._id.toHexString(),
    specVersion: spec.currentVersion,
    connection: connection.updatedAt.getTime(),
    mode: identity.mode,
    role: identity.role,
    userId: identity.userId,
    toolName,
    args,
  });
}
