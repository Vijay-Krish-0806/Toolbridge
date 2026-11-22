/**
 * Kept as a test because it guards reliability: the circuit opens after N failures in a row,
 * refuses while open, lets exactly one probe through after the cool-down, and closes or
 * reopens on that probe's result (Step 4.5).
 */
import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

function breaker() {
  let now = 0;
  const b = new CircuitBreaker({ failureThreshold: 3, openMs: 1000, now: () => now });
  return { b, advance: (ms: number) => (now += ms) };
}

describe('CircuitBreaker', () => {
  it('opens after the threshold of failures in a row, and a success resets the count', () => {
    const { b } = breaker();
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe('closed');
    b.recordFailure();
    expect(b.state()).toBe('open');
    expect(b.allow()).toBe(false);
  });

  it('after the cool-down lets ONE probe through; its success closes the circuit', () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    expect(b.state()).toBe('half_open');
    expect(b.allow()).toBe(true); // the probe
    expect(b.allow()).toBe(false); // everyone else waits for it
    b.recordSuccess();
    expect(b.state()).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('a failed probe opens it again at once', () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure();
    advance(1000);
    expect(b.allow()).toBe(true);
    b.recordFailure();
    expect(b.state()).toBe('open');
    expect(b.retryAfterMs()).toBe(1000);
  });
});
