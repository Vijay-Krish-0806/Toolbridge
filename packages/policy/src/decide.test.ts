/**
 * Kept as a test because this is a security boundary: these rules decide which tools a person can
 * make the agent run. Each case pins one rule (deny by default, deny wins, anchored patterns,
 * prototype-safe role lookup, strict file parsing), so a refactor cannot loosen one unnoticed.
 */
import { describe, expect, it } from 'vitest';

import { createAuthorizer, decide, matches } from './decide.js';
import { parsePolicy } from './policy.js';

const policy = parsePolicy({
  version: 1,
  roles: {
    owner: { allow: ['*'] },
    support: { allow: ['orders_*', 'refunds_request'], deny: ['orders_cancel'] },
    nobody: {},
  },
});

describe('decide', () => {
  it('allows a tool an allow pattern matches', () => {
    expect(decide(policy, 'support', 'orders_get')).toEqual({ allowed: true });
    expect(decide(policy, 'support', 'refunds_request')).toEqual({ allowed: true });
    expect(decide(policy, 'owner', 'anything_at_all')).toEqual({ allowed: true });
  });

  it('denies by default: no matching allow pattern', () => {
    expect(decide(policy, 'support', 'refunds_approve')).toMatchObject({ allowed: false });
    expect(decide(policy, 'nobody', 'orders_get')).toMatchObject({ allowed: false });
  });

  it('denies an unknown role, including names found on Object.prototype', () => {
    for (const role of ['guest', '', 'constructor', '__proto__', 'toString']) {
      expect(decide(policy, role, 'orders_get')).toEqual({
        allowed: false,
        reason: `Role "${role}" has no permissions.`,
      });
    }
  });

  it('lets deny win over allow', () => {
    expect(decide(policy, 'support', 'orders_cancel')).toEqual({
      allowed: false,
      reason: 'Role "support" is denied tool "orders_cancel" (rule "orders_cancel").',
    });
  });

  it('works through the authorizer used by agent-core', () => {
    const authorizer = createAuthorizer(policy);
    expect(authorizer.authorize({ userId: 'u1', role: 'support' }, 'orders_cancel').allowed).toBe(
      false,
    );
  });
});

describe('matches', () => {
  it('matches whole names only', () => {
    expect(matches('orders_*', 'orders_get')).toBe(true);
    expect(matches('orders_*', 'customers_list_orders')).toBe(false);
    expect(matches('orders', 'orders_get')).toBe(false);
    expect(matches('*_get', 'orders_get')).toBe(true);
  });
});

describe('parsePolicy', () => {
  it('rejects unknown fields, bad patterns and a missing version', () => {
    expect(() => parsePolicy({ roles: {} })).toThrow(/Invalid policy/);
    expect(() => parsePolicy({ version: 1, roles: { owner: { allow: ['orders.*'] } } })).toThrow(
      /tool-name characters/,
    );
    // A typo such as "allows" must fail, not silently grant nothing.
    expect(() => parsePolicy({ version: 1, roles: { owner: { allows: ['*'] } } })).toThrow(
      /Invalid policy/,
    );
  });
});
