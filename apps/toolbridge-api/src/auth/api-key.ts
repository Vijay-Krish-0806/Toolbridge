/**
 * Tenant API keys: `tb_<keyId>_<secret>`.
 * - keyId (16 hex chars) is public and is the database id, so a key is found by one indexed lookup.
 * - secret (32 random bytes, base64url) is shown once, at creation; only sha256(secret) is stored.
 *
 * Why plain SHA-256 is right here but wrong for passwords: a password is short and guessable, so
 * its hash must be slow (bcrypt, scrypt, Argon2) to make guessing expensive. This secret is 256
 * random bits; no one can guess it, fast hash or not, and a fast hash keeps every request cheap.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PATTERN = /^tb_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;

export interface NewApiKey {
  keyId: string;
  /** The full key, to show the caller exactly once. */
  token: string;
  /** What gets stored. */
  secretHash: string;
}

/** sha256 of a string, as hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A new random key and the hash to store. */
export function generateApiKey(): NewApiKey {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { keyId, token: `tb_${keyId}_${secret}`, secretHash: sha256Hex(secret) };
}

/**
 * Splits a presented key into id and secret, or returns null when it is not well formed.
 * Before -> after: `'tb_0123456789abcdef_<43 chars>'` -> `{ keyId: '0123456789abcdef', secret: '<43 chars>' }`.
 */
export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  const match = KEY_PATTERN.exec(token);
  if (!match?.[1] || !match[2]) return null;
  return { keyId: match[1], secret: match[2] };
}

/** A hash no real secret has, compared against when the key id is unknown (see secretMatches). */
const DUMMY_HASH = sha256Hex('no-such-key');

/**
 * Compares a presented secret with the stored hash in constant time. `storedHash` is undefined when
 * no key has that id: the same comparison still runs against a dummy hash, so an unknown id and a
 * wrong secret take the same time and look the same (401) from outside.
 */
export function secretMatches(secret: string, storedHash: string | undefined): boolean {
  const presented = Buffer.from(sha256Hex(secret), 'hex');
  const expected = Buffer.from(storedHash ?? DUMMY_HASH, 'hex');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(presented, expected) && storedHash !== undefined;
}

/**
 * Constant-time comparison of the platform admin key. Both sides are hashed first, so the
 * comparison is always 32 bytes against 32 bytes and does not reveal the key's length.
 */
export function adminKeyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    Buffer.from(sha256Hex(presented), 'hex'),
    Buffer.from(sha256Hex(expected), 'hex'),
  );
}
