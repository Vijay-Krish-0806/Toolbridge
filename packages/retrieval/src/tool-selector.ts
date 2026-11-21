/**
 * Step 3.2: which tools to offer the model for one request. Policy:
 * 1. search the tool index with the request text,
 * 2. take the top k; if even the best match is weak (top score below `minTopScore`), widen to
 *    `kFallback`, because a weak best match means the ranking is unsure, not that no tool fits,
 * 3. always add the core set (tools almost every conversation needs, such as an order lookup).
 * The result matches agent-core's ToolSelector port by shape, so agent-core needs no Mongo code.
 */
import type { IndexScope, ToolIndex, ToolMatch } from './tool-index.js';

export interface SelectorOptions {
  /** Tools to offer normally. */
  k: number;
  /** Tools to offer when the best match is weak. */
  kFallback: number;
  /** Top-1 score below this triggers the fallback. Calibrate it on measured scores. */
  minTopScore: number;
  /** Always offered, whatever the query. Keep it small: every tool costs tokens on every call. */
  core: string[];
}

/**
 * The Step 3.2 baseline policy (docs/results/retrieval-baseline.md). 0.85 was the lowest
 * threshold that helped on the host set; higher ones cost more tokens than they gained.
 * Calibrated on the same questions it is scored on, so treat it as a starting point.
 */
export const DEFAULT_SELECTOR: Omit<SelectorOptions, 'core'> = {
  k: 5,
  kFallback: 15,
  minTopScore: 0.85,
};

export interface VectorToolSelection {
  /** Tool names to offer, best match first, then core tools that were not already included. */
  names: string[];
  mode: 'top_k' | 'fallback';
  topScore?: number;
  /** The ranked matches that were considered (up to kFallback), for logs and evals. */
  matches: ToolMatch[];
}

export class VectorToolSelector {
  /** Validates the options once, so a bad k fails at startup instead of on a request. */
  constructor(
    private readonly index: ToolIndex,
    private readonly scope: IndexScope,
    private readonly options: SelectorOptions,
  ) {
    if (options.k < 1 || options.kFallback < options.k) {
      throw new Error('Selector needs k >= 1 and kFallback >= k.');
    }
  }

  /**
   * Selects tools for one request text. One search for `kFallback` results covers both cases.
   * With `allowed` (Step 4.2), the search sees only those tools, and core tools outside it are
   * dropped, so every name returned is one the person may use.
   * Before -> after: `'is ORD-1042 shipped yet?'` (k 5, core ['orders_get']) ->
   * `{ names: ['shipments_get', 'orders_get', ...5 total], mode: 'top_k', topScore: 0.87 }`
   * (scores illustrative).
   */
  async select(query: string, options: { allowed?: string[] } = {}): Promise<VectorToolSelection> {
    const { allowed } = options;
    const scope = allowed ? { ...this.scope, toolNames: allowed } : this.scope;
    const matches = await this.index.search(scope, query, this.options.kFallback);
    // A core tool the person may not use is not offered either.
    const core = allowed
      ? this.options.core.filter((name) => allowed.includes(name))
      : this.options.core;
    return selectFromMatches(matches, { ...this.options, core });
  }
}

/**
 * The pure part of the policy, separate so the eval can replay it on stored matches.
 * Before -> after: matches with top score 0.62 (< minTopScore 0.7), kFallback 15 ->
 * `mode: 'fallback'`, the 15 best names plus any core tool not among them.
 */
export function selectFromMatches(
  matches: ToolMatch[],
  options: SelectorOptions,
): VectorToolSelection {
  const topScore = matches[0]?.score;
  const weak = topScore === undefined || topScore < options.minTopScore;
  const ranked = matches.slice(0, weak ? options.kFallback : options.k).map((m) => m.toolName);
  const names = [...new Set([...ranked, ...options.core])];
  return {
    names,
    mode: weak ? 'fallback' : 'top_k',
    ...(topScore !== undefined && { topScore }),
    matches,
  };
}
