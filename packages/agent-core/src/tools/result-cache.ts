/**
 * The tool-result cache port (Step 4.8, ADR 0046). The executor asks it before a read and tells it
 * about every write; the app decides where results live (the platform uses Redis), who may share
 * one and for how long. agent-core never sees a cache server.
 *
 * Pattern: CACHE-ASIDE with a VERSION. Each API has a version; a write changes it, which makes every
 * older result unusable at once. A result is stored under the version seen BEFORE its call went
 * out, so a read that overlaps a write is never served later:
 *
 *   read:   version 5 ----- call (old data) ------------ store under 5   <- useless, version is 7
 *   write:            version 6 -- change -- version 7
 */

/** A read the executor wants to look up. */
export interface CacheableCall {
  callId: string;
  toolName: string;
  /** The validated arguments, so two spellings of the same JSON count as the same call. */
  args: unknown;
}

/**
 * What a lookup found: the stored result, or nothing plus a way to store the result of this call.
 * `store` remembers the version of the lookup; that is why it is not a method of the cache.
 */
export type CacheLookup =
  { hit: true; content: string } | { hit: false; store: (content: string) => Promise<void> };

export interface ToolResultCache {
  /** undefined: this call is not cached at all (for example, the tenant left the cache off). */
  lookup(call: CacheableCall): Promise<CacheLookup | undefined>;
  /** Makes every result stored so far for this API unusable. */
  invalidate(): Promise<void>;
}

/**
 * The cache as the executor uses it: it can only ever help. A cache that fails (Redis is down) is
 * a miss, and a result that cannot be stored is just not cached. A failed invalidation is the app's
 * to report; results it should have removed then live until their TTL, which is always short.
 * Before -> after: a cache whose every method rejects -> lookups that find nothing.
 */
export function forgivingCache(cache: ToolResultCache): ToolResultCache {
  return {
    lookup: async (call) => {
      const found = await cache.lookup(call).catch(() => undefined);
      if (found?.hit !== false) return found;
      return { hit: false, store: (content) => found.store(content).catch(() => undefined) };
    },
    invalidate: () => cache.invalidate().catch(() => undefined),
  };
}
