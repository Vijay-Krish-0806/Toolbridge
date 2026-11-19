/**
 * Envelope encryption protects every tenant credential, so its guarantees are pinned by tests:
 * round trip, binding to the owner (AAD), tamper detection, fresh IVs, and master-key rotation.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DecryptionError, decryptSecret, encryptSecret, rewrapSecret } from './envelope.js';
import { LocalKeyProvider } from './key-provider.js';

const AAD = 'tenant:aaaaaaaaaaaaaaaaaaaaaaaa:connection:bbbbbbbbbbbbbbbbbbbbbbbb';
const SECRET = JSON.stringify({ bearer: 'super-secret-token' });

/** Flips one bit of a base64 field, as an attacker editing the database would. */
function flip(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64');
}

describe('envelope encryption', () => {
  const keys = new LocalKeyProvider('v1', randomBytes(32));

  it('round-trips, and stores neither the secret nor the data key in clear', () => {
    const encrypted = encryptSecret(SECRET, AAD, keys);
    expect(decryptSecret(encrypted, AAD, keys)).toBe(SECRET);
    expect(JSON.stringify(encrypted)).not.toContain('super-secret-token');
    expect(encrypted.dataKey.keyVersion).toBe('v1');
  });

  it('uses a fresh data key and a fresh 12-byte IV every time', () => {
    const a = encryptSecret(SECRET, AAD, keys);
    const b = encryptSecret(SECRET, AAD, keys);
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.dataKey.ciphertext).not.toBe(b.dataKey.ciphertext);
  });

  it("fails when decrypted under another tenant's AAD (copied between records)", () => {
    const encrypted = encryptSecret(SECRET, AAD, keys);
    const otherTenant = AAD.replace('aaaa', 'cccc');
    expect(() => decryptSecret(encrypted, otherTenant, keys)).toThrow(DecryptionError);
  });

  it.each(['ciphertext', 'tag', 'iv'] as const)(
    'fails when the stored %s was tampered with',
    (field) => {
      const encrypted = encryptSecret(SECRET, AAD, keys);
      expect(() =>
        decryptSecret({ ...encrypted, [field]: flip(encrypted[field]) }, AAD, keys),
      ).toThrow(DecryptionError);
    },
  );

  it('fails when the wrapped data key was tampered with', () => {
    const encrypted = encryptSecret(SECRET, AAD, keys);
    const dataKey = { ...encrypted.dataKey, ciphertext: flip(encrypted.dataKey.ciphertext) };
    expect(() => decryptSecret({ ...encrypted, dataKey }, AAD, keys)).toThrow(DecryptionError);
  });

  it('fails under a different master key, with a message that reveals nothing', () => {
    const encrypted = encryptSecret(SECRET, AAD, keys);
    const otherKeys = new LocalKeyProvider('v1', randomBytes(32));
    expect(() => decryptSecret(encrypted, AAD, otherKeys)).toThrow(
      'Stored secret could not be decrypted.',
    );
  });

  it('rotates the master key by re-wrapping only the data key', () => {
    const v1 = randomBytes(32);
    const old = new LocalKeyProvider('v1', v1);
    const encrypted = encryptSecret(SECRET, AAD, old);

    const v2 = randomBytes(32);
    const rotated = new LocalKeyProvider('v2', v2, { v1 });
    const rewrapped = rewrapSecret(encrypted, AAD, rotated);
    expect(rewrapped.dataKey.keyVersion).toBe('v2');
    expect(rewrapped.ciphertext).toBe(encrypted.ciphertext); // the secret itself was not touched
    expect(decryptSecret(rewrapped, AAD, rotated)).toBe(SECRET);

    // Once v1 is retired, only re-wrapped secrets still decrypt.
    const retired = new LocalKeyProvider('v2', v2);
    expect(decryptSecret(rewrapped, AAD, retired)).toBe(SECRET);
    expect(() => decryptSecret(encrypted, AAD, retired)).toThrow(DecryptionError);
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => new LocalKeyProvider('v1', randomBytes(16))).toThrow('32 bytes');
  });
});
