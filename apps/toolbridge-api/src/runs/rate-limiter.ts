import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { CircuitBreaker } from '@toolbridge/agent-core';
import { Redis } from 'ioredis';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { redisOptions } from './run-queue.js';

/**
 * A TOKEN BUCKET in Redis, as one Lua script (Step 4.5, ADR 0041). Redis runs a script atomically,
 * so two API or worker processes can never both take the last token. The time comes from Redis
 * itself (TIME), so processes with different clocks agree.
 *
 * The bucket holds up to `capacity` tokens and refills `rate` tokens per millisecond. A request
 * takes one: allowed if there was one, otherwise told how long until there will be.
 */
const TAKE = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * rate)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) + 1000)
return { allowed, wait }
`;

/** What is limited, per tenant. */
export type RateName = 'runs' | 'tool-calls';

@Injectable()
export class RateLimiter implements OnApplicationShutdown {
  private readonly redis: Redis;
  private readonly limits: Record<RateName, { capacity: number; perMs: number }>;

  constructor(@Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig) {
    this.redis = new Redis(redisOptions(config));
    this.limits = {
      // Runs per minute, with a burst of the same size.
      runs: { capacity: config.RATE_RUNS_PER_MINUTE, perMs: config.RATE_RUNS_PER_MINUTE / 60_000 },
      // Tool calls per second, with a burst of twice that (a turn often makes a few at once).
      'tool-calls': {
        capacity: config.RATE_TOOL_CALLS_PER_SECOND * 2,
        perMs: config.RATE_TOOL_CALLS_PER_SECOND / 1000,
      },
    };
  }

  /**
   * Takes one token of `name` for the tenant.
   * Before -> after: ('runs', tenant) -> `{ allowed: true, retryAfterMs: 0 }`, or once the bucket
   * is empty `{ allowed: false, retryAfterMs: 1800 }`.
   */
  async take(
    name: RateName,
    tenantId: string,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const { capacity, perMs } = this.limits[name];
    const key = `${this.config.RUN_QUEUE_PREFIX}:ratelimit:${name}:${tenantId}`;
    const [allowed, wait] = (await this.redis.eval(TAKE, 1, key, capacity, perMs)) as [
      number,
      number,
    ];
    return { allowed: allowed === 1, retryAfterMs: wait };
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * One circuit breaker per tenant and spec (one API) in this process (Step 4.5). In memory: each
 * worker learns on its own that an API is failing, which is enough to stop hammering it; a
 * breaker shared through Redis is not needed at this scale.
 */
@Injectable()
export class Breakers {
  private readonly breakers = new Map<string, CircuitBreaker>();

  for(tenantId: string, specId: string): CircuitBreaker {
    const key = `${tenantId}:${specId}`;
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 30_000 });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
