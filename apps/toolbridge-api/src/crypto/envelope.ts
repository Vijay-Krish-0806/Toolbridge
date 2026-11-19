/**
 * Envelope encryption for tenant secrets.
 *
 *   secret --AES-256-GCM(DEK, iv, AAD)--> ciphertext + tag      (stored)
 *   DEK (random per secret) --wrap(master key)--> wrapped DEK   (stored, with the key version)
 *   master key: never stored with the data (env here, a KMS in production)
 *
 * Why two layers: rotating the master key only re-wraps the small DEKs (rewrapSecret); no secret
 * is re-encrypted. And with a KMS, the master key never leaves the KMS.
 * AAD (additional authenticated data) binds the ciphertext to its owner, for example
 * "tenant:<id>:connection:<id>": the same bytes stored under another tenant fail to decrypt.
 * Nothing here logs or returns secrets in errors.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyProvider, WrappedKey } from './key-provider.js';

export interface EncryptedSecret {
  algorithm: 'AES-256-GCM';
  /** The data key, wrapped by the master key (includes the master key version). */
  dataKey: WrappedKey;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** One message for every failure, so errors reveal nothing about which part was wrong. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
  /** Fixed text on purpose. */
  constructor() {
    super('Stored secret could not be decrypted.');
  }
}

/**
 * Encrypts a secret under a fresh data key. A new random DEK and a new random 12-byte IV every
 * time, so encrypting the same secret twice gives unrelated outputs (GCM must never reuse an IV
 * with the same key).
 */
export function encryptSecret(plaintext: string, aad: string, keys: KeyProvider): EncryptedSecret {
  const dataKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      algorithm: 'AES-256-GCM',
      dataKey: keys.wrap(dataKey, Buffer.from(aad)),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  } finally {
    dataKey.fill(0); // do not leave the plaintext key in memory longer than needed
  }
}

/**
 * Decrypts a secret. Fails (DecryptionError) if the AAD differs, if any stored byte was changed,
 * or if the master key version is unknown: GCM's tag check covers both the DEK and the secret.
 */
export function decryptSecret(secret: EncryptedSecret, aad: string, keys: KeyProvider): string {
  let dataKey: Buffer | undefined;
  try {
    dataKey = keys.unwrap(secret.dataKey, Buffer.from(aad));
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(secret.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DecryptionError();
  } finally {
    dataKey?.fill(0);
  }
}

/**
 * Master-key rotation for one secret: unwrap the DEK with its old master key, wrap it with the
 * current one. The secret's ciphertext, IV and tag are unchanged.
 * Before -> after: `dataKey.keyVersion: 'v1'` -> `'v2'`, everything else identical.
 */
export function rewrapSecret(
  secret: EncryptedSecret,
  aad: string,
  keys: KeyProvider,
): EncryptedSecret {
  if (secret.dataKey.keyVersion === keys.currentVersion) return secret;
  let dataKey: Buffer | undefined;
  try {
    dataKey = keys.unwrap(secret.dataKey, Buffer.from(aad));
    return { ...secret, dataKey: keys.wrap(dataKey, Buffer.from(aad)) };
  } catch {
    throw new DecryptionError();
  } finally {
    dataKey?.fill(0);
  }
}
