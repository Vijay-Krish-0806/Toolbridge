/**
 * API keys are how tenants authenticate, so the helpers are pinned by tests: format, hashing,
 * and comparisons that fail closed.
 */
import { describe, expect, it } from 'vitest';

import {
  adminKeyMatches,
  generateApiKey,
  parseApiKey,
  secretMatches,
  sha256Hex,
} from './api-key.js';

describe('API keys', () => {
  it('generates a key that parses back, and stores only a hash of the secret', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.token);
    expect(parsed?.keyId).toBe(key.keyId);
    expect(parsed && secretMatches(parsed.secret, key.secretHash)).toBe(true);
    expect(key.token).not.toContain(key.secretHash);
    expect(key.secretHash).toBe(sha256Hex(parsed?.secret ?? ''));
  });

  it('two keys never share an id or secret', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secretHash).not.toBe(b.secretHash);
  });

  it.each([
    '',
    'Bearer x',
    'tb_short_secret',
    `tb_${'g'.repeat(16)}_${'a'.repeat(43)}`,
    `tb_${'a'.repeat(16)}_${'a'.repeat(42)}`,
  ])('rejects a malformed key %j', (token) => {
    expect(parseApiKey(token)).toBeNull();
  });

  it('fails for a wrong secret, an unknown key id, or a corrupt stored hash', () => {
    const key = generateApiKey();
    const other = parseApiKey(generateApiKey().token);
    expect(secretMatches(other?.secret ?? '', key.secretHash)).toBe(false);
    expect(secretMatches(other?.secret ?? '', undefined)).toBe(false);
    expect(secretMatches(other?.secret ?? '', 'abcd')).toBe(false);
  });

  it('compares the admin key exactly, whatever the lengths', () => {
    const admin = 'a'.repeat(40);
    expect(adminKeyMatches(admin, admin)).toBe(true);
    expect(adminKeyMatches(`${admin}x`, admin)).toBe(false);
    expect(adminKeyMatches('short', admin)).toBe(false);
  });
});
