/**
 * Who holds the master key (KEK, key-encryption key). A port: the local provider below keeps the
 * key in process memory from configuration; a KMS provider (AWS KMS, Google Cloud KMS, Vault
 * Transit) would send the data key to a service that never hands out the master key at all.
 * Only this file touches master-key bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A data key encrypted under one master-key version. Stored next to the secret it protects. */
export interface WrappedKey {
  /** Which master key wrapped it, so rotation and decryption pick the right one. */
  keyVersion: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface KeyProvider {
  /** The version new wraps use. */
  readonly currentVersion: string;
  /** Encrypts a data key with the current master key. */
  wrap(dataKey: Buffer, aad: Buffer): WrappedKey;
  /** Decrypts a data key with the master key it was wrapped with. Throws if anything is wrong. */
  unwrap(wrapped: WrappedKey, aad: Buffer): Buffer;
}

/**
 * Master keys held locally (from env). AES-256-GCM, a fresh random 12-byte IV per wrap, and the
 * same AAD as the secret, so a wrapped key copied to another record does not unwrap.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Buffer>;

  /** `previous` are older versions kept for unwrapping during a rotation. */
  constructor(
    readonly currentVersion: string,
    current: Buffer,
    previous: Record<string, Buffer> = {},
  ) {
    if (current.length !== 32) throw new Error('The master key must be 32 bytes.');
    this.keys = new Map([...Object.entries(previous), [currentVersion, current]]);
  }

  /** Wraps a data key under the current master key. */
  wrap(dataKey: Buffer, aad: Buffer): WrappedKey {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(this.currentVersion), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      keyVersion: this.currentVersion,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /** Unwraps with the master key named in `wrapped.keyVersion`. GCM verifies tag and AAD. */
  unwrap(wrapped: WrappedKey, aad: Buffer): Buffer {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(wrapped.keyVersion),
      Buffer.from(wrapped.iv, 'base64'),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  /** The master key for a version; an unknown version is an error, never a fallback. */
  private key(version: string): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown master key version "${version}".`);
    return key;
  }
}
