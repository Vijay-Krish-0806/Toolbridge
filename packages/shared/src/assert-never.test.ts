import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.js';

type SafetyClass = 'read' | 'write';

function describeSafety(safety: SafetyClass): string {
  switch (safety) {
    case 'read':
      return 'safe to retry';
    case 'write':
      return 'needs idempotency';
    default:
      return assertNever(safety);
  }
}

describe('assertNever', () => {
  it('is unreachable when every member of the union is handled', () => {
    expect(describeSafety('read')).toBe('safe to retry');
    expect(describeSafety('write')).toBe('needs idempotency');
  });

  it('throws with the unexpected value when untyped data slips through', () => {
    const fromUntypedSource = 'delete' as unknown as SafetyClass;
    expect(() => describeSafety(fromUntypedSource)).toThrow('Unexpected value: "delete"');
  });
});
