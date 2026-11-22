/**
 * A CIRCUIT BREAKER (Step 4.5, ADR 0041): when an API keeps failing, stop calling it for a while
 * instead of making every run wait for timeouts and pile more load on a struggling service.
 *
 *   closed --(N failures in a row)--> open --(cool-down over)--> half-open
 *     ^                                                            |
 *     +------------------(the one probe call succeeds)-------------+
 *                         (the probe fails: open again)
 *
 * Only signs that the API itself is unwell count as failures: network errors, timeouts and 5xx.
 * A 4xx is the API working and answering (for example "order not found"), so it counts as
 * healthy. One breaker per API; in this project, one per tenant and spec in each worker process.
 */
export interface CircuitBreakerOptions {
  /** Failures in a row that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long it stays open before one probe is allowed. Default 30 s. */
  openMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Where the circuit stands now. */
  state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.now() - this.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  /**
   * May a call go out? Closed: yes. Open: no. Half-open: yes for exactly ONE probe call; the
   * others wait for its result (they are refused until it has closed or reopened the circuit).
   */
  allow(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  /** The API answered (any 2xx or 4xx): the circuit closes and the count starts over. */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /** The API looked unwell (network, timeout, 5xx). A failed probe reopens it at once. */
  recordFailure(): void {
    this.failures++;
    if (this.probing || this.failures >= this.threshold) this.openedAt = this.now();
    this.probing = false;
  }

  /** Milliseconds until a probe is allowed (0 when not open). */
  retryAfterMs(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }
}
