import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/**
 * Hashes a password with scrypt, a deliberately slow, memory-hard function built into Node.
 * The salt makes equal passwords produce different hashes. Pass a salt only for repeatable
 * seed data; real sign-ups must use the random default.
 */
export function hashPassword(password: string, salt: string = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`;
}

/** Constant-time comparison, so response timing does not leak how much of the hash matched. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
