import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { KEY_PROVIDER } from '../common/core.module.js';
import { DecryptionError, decryptSecret } from '../crypto/envelope.js';
import type { KeyProvider } from '../crypto/key-provider.js';
import { MODEL, type Session } from '../domain/models.js';

/** The AAD that binds an encrypted host token to its tenant and session. */
export function sessionAad(tenantId: Types.ObjectId, jti: string): string {
  return `tenant:${tenantId.toHexString()}:session:${jti}`;
}

/**
 * Reads a session's host user token, the credential of a delegated call (Step 4.4c). Lives in
 * the shared platform module because the WORKER uses it: the token is decrypted only at the
 * moment a tool call needs it, held in memory for that call, and never logged or returned.
 */
@Injectable()
export class UserTokenStore {
  constructor(
    @InjectModel(MODEL.Session.name) private readonly model: Model<Session>,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  /**
   * The host token of the tenant's session `jti`, or null when it cannot be used: no such
   * session (or another tenant's), revoked (logged out), expired, or minted without a token.
   * The ciphertext only decrypts with its own tenant and session id (AAD), so a copy pasted into
   * another session's record fails.
   * Before -> after: (tenant, '3f2c…') -> `{ userId: 'u1', token: '<host token>' }`.
   */
  async tokenFor(
    tenantId: Types.ObjectId,
    jti: string,
  ): Promise<{ userId: string; token: string } | null> {
    const session = await this.model.findOne({ _id: jti, tenantId }).lean<Session>().exec();
    if (!session?.userToken || session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    try {
      const token = decryptSecret(session.userToken, sessionAad(tenantId, jti), this.keys);
      return { userId: session.userId, token };
    } catch (error) {
      // Tampered, or copied from another session or tenant: unusable, never a crash.
      if (error instanceof DecryptionError) return null;
      throw error;
    }
  }

  /** True when the session holds a usable host token (checked before a run starts or resumes). */
  async has(tenantId: Types.ObjectId, jti: string): Promise<boolean> {
    return (await this.tokenFor(tenantId, jti)) !== null;
  }
}
