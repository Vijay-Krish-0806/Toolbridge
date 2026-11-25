/**
 * Required test (approvals): these rules decide which writes wait for a person, so each case
 * pins one rule: reads never wait, writes wait by default, the first matching rule decides, a
 * threshold only applies above it (and a missing argument never loosens the level), the
 * strictest call decides the batch, and a bad rule fails at load time.
 */
import { describe, expect, it } from 'vitest';

import { approvalFor, batchApproval, type CallToCheck, type Exposure } from './approvals.js';
import { parsePolicy } from './policy.js';

const policy = parsePolicy({
  version: 1,
  roles: {},
  approvals: {
    rules: [
      { tools: ['orders_update_notes'], approval: 'none' },
      { tools: ['refunds_request'], arg: 'amountCents', above: 10000, approval: 'high' },
      { tools: ['orders_cancel'], approval: 'high' },
    ],
  },
});
const write = (name: string, args: Record<string, unknown> = {}) =>
  ({ name, safety: 'write', args }) as const;

describe('approvalFor', () => {
  it('never asks for reads, even when a rule names the tool', () => {
    expect(approvalFor(policy, { name: 'orders_cancel', safety: 'read', args: {} }).level).toBe(
      'none',
    );
  });

  it('asks for every write by default, also when the policy has no approvals section', () => {
    expect(approvalFor(policy, write('customers_update')).level).toBe('required');
    const bare = parsePolicy({ version: 1, roles: {} });
    expect(approvalFor(bare, write('anything')).level).toBe('required');
  });

  it('lets the first matching rule decide', () => {
    expect(approvalFor(policy, write('orders_update_notes')).level).toBe('none');
    expect(approvalFor(policy, write('orders_cancel')).level).toBe('high');
  });

  it('applies a threshold only above it; a missing or non-number argument falls through', () => {
    expect(approvalFor(policy, write('refunds_request', { amountCents: 32893 })).level).toBe(
      'high',
    );
    expect(approvalFor(policy, write('refunds_request', { amountCents: 10000 })).level).toBe(
      'required',
    );
    expect(approvalFor(policy, write('refunds_request', {})).level).toBe('required');
    expect(approvalFor(policy, write('refunds_request', { amountCents: '99999' })).level).toBe(
      'required',
    );
  });
});

describe('batchApproval', () => {
  it('uses the strictest level in the turn and keeps each call level', () => {
    const batch = batchApproval(
      policy,
      [
        { name: 'orders_get', safety: 'read', args: {} },
        write('orders_update_notes'),
        write('refunds_request', { amountCents: 50000 }),
      ],
      'none',
    );
    expect(batch.level).toBe('high');
    expect(batch.calls.map((c) => c.level)).toEqual(['none', 'none', 'high']);
    expect(batchApproval(policy, [], 'flagged').level).toBe('none');
  });
});

describe('the exposure rule (Step 4.9)', () => {
  const levels = (exposure: Exposure, ...calls: CallToCheck[]) =>
    batchApproval(policy, calls, exposure).calls.map((c) => c.level);
  const notes = write('orders_update_notes'); // the policy says none
  const refund = write('refunds_request', { amountCents: 500 }); // required
  const cancel = write('orders_cancel'); // high

  it('after reading tool data, every write waits for a person', () => {
    expect(levels('none', notes, refund, cancel)).toEqual(['none', 'required', 'high']);
    expect(levels('seen', notes, refund, cancel)).toEqual(['required', 'required', 'high']);
  });

  it('after reading text that looks like instructions, for someone else', () => {
    expect(levels('flagged', notes, refund, cancel)).toEqual(['high', 'high', 'high']);
  });

  it('also under a policy that asks for nothing', () => {
    const open = parsePolicy({ version: 1, roles: {}, approvals: { default: 'none' } });
    expect(batchApproval(open, [write('anything')], 'none').level).toBe('none');
    expect(batchApproval(open, [write('anything')], 'seen').level).toBe('required');
    expect(batchApproval(open, [write('anything')], 'flagged').level).toBe('high');
  });

  it('leaves reads and local tools alone', () => {
    const read = { name: 'orders_get', safety: 'read', args: {} } as const;
    const local = { ...notes, local: true };
    expect(levels('flagged', read, local)).toEqual(['none', 'none']);
  });
});

describe('approval rules in the policy file', () => {
  it('rejects a threshold without its argument and an unknown level', () => {
    const bad = (rule: unknown) => () =>
      parsePolicy({ version: 1, roles: {}, approvals: { rules: [rule] } });
    expect(bad({ tools: ['x'], above: 5, approval: 'high' })).toThrow(/must be given together/);
    expect(bad({ tools: ['x'], approval: 'maybe' })).toThrow(/Invalid policy/);
  });
});
