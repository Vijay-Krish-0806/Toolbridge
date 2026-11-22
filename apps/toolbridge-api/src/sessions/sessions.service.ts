import { randomUUID } from 'node:crypto';

import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';

import { KEY_PROVIDER, PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { encryptSecret } from '../crypto/envelope.js';
import type { KeyProvider } from '../crypto/key-provider.js';
import { MODEL, type Session } from '../domain/models.js';
import { PoliciesService } from '../policies/policies.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { InvalidSessionToken, signSessionToken, verifySessionToken } from './session-token.js';

/** Default and longest session lifetime: short, because a token in a browser can leak. */
export const DEFAULT_SESSION_SECONDS = 15 * 60;
export const MAX_SESSION_SECONDS = 60 * 60;

/** A request made with a verified, unrevoked session token. */
export interface SessionCaller {
  tenantId: Types.ObjectId;
  jti: string;
  specId: string;
  userId: string;
  role: string;
}

export interface MintInput {
  specId: string;
  userId: string;
  role: string;
  ttlSeconds?: number;
  /** The host user's own API token, for user delegation (Step 4.4c). Stored encrypted only. */
  userToken?: string;
}

/** The AAD that binds an encrypted host token to its tenant and session. */
export function sessionAad(tenantId: Types.ObjectId, jti: string): string {
  return `tenant:${tenantId.toHexString()}:session:${jti}`;
}

/**
 * Token exchange (Step 4.4b, ADRs 0027, 0029, 0036). The host's BACKEND, holding the tenant API
 * key, asks for a session for one of its users; ToolBridge returns a short-lived signed token
 * that the host gives to its browser code. The browser never sees the API key, and the role in
 * the token comes from the host's server, so a user cannot pick their own role.
 */
@Injectable()
export class SessionsService {
  private readonly signingKey: Uint8Array;

  constructor(
    @Inject(PLATFORM_CONFIG) config: PlatformConfig,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @InjectModel(MODEL.Session.name) private readonly model: Model<Session>,
    private readonly specs: SpecsService,
    private readonly policies: PoliciesService,
  ) {
    this.signingKey = new Uint8Array(config.PLATFORM_SESSION_KEY);
  }

  /**
   * Mints a session token for one host user of one spec.
   * Before -> after: (tenant key, `{ specId, userId: 'u1', role: 'support' }`) ->
   * `{ token: 'eyJ…', expiresAt }`.
   * Only a role that the spec's current policy defines can be minted (422 otherwise; a spec with
   * no policy has no roles, so nothing can be minted for it).
   */
  async mint(
    tenantId: Types.ObjectId,
    keyId: string,
    input: MintInput,
  ): Promise<{ token: string; expiresAt: Date }> {
    const spec = await this.specs.requireSpec(tenantId, input.specId);
    const { policy, version } = await this.policies.forRun(tenantId, spec);
    if (version === null) {
      throw new UnprocessableEntityException(
        'This spec has no policy, so no role can be given a session.',
      );
    }
    if (!Object.hasOwn(policy.roles, input.role)) {
      throw new UnprocessableEntityException(
        `Role "${input.role}" is not in this spec's policy (roles: ${Object.keys(policy.roles).join(', ') || 'none'}).`,
      );
    }
    const jti = randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (input.ttlSeconds ?? DEFAULT_SESSION_SECONDS) * 1000,
    );
    await new this.model({
      _id: jti,
      tenantId,
      specId: spec._id,
      userId: input.userId,
      role: input.role,
      mintedBy: { kind: 'api_key', keyId },
      expiresAt,
      revokedAt: null,
      // Encrypted under a fresh data key, bound to this tenant and session by the AAD: a copy
      // of the ciphertext in another record does not decrypt.
      userToken:
        input.userToken === undefined
          ? null
          : encryptSecret(input.userToken, sessionAad(tenantId, jti), this.keys),
      createdAt: now,
    }).save();
    const token = await signSessionToken(
      {
        jti,
        tenantId: tenantId.toHexString(),
        specId: spec._id.toHexString(),
        userId: input.userId,
        role: input.role,
        expiresAt,
      },
      this.signingKey,
    );
    return { token, expiresAt };
  }

  /**
   * Turns a bearer token into a caller, or throws InvalidSessionToken. Two checks:
   * 1. the signature and claims (session-token.ts): forged, expired, wrong audience or
   *    algorithm all fail here;
   * 2. the server-side record: the token's `jti` must exist, be unrevoked and unexpired, and
   *    agree with the claims. A revoked token replayed later fails here.
   */
  async resolve(token: string): Promise<SessionCaller> {
    const claims = await verifySessionToken(token, this.signingKey);
    // Looked up by id before the tenant is trusted (like the API-key lookup), then cross-checked.
    const record = await this.model.findOne({ _id: claims.jti }).lean<Session>().exec();
    const matches =
      record !== null &&
      record.revokedAt === null &&
      record.expiresAt.getTime() > Date.now() &&
      record.tenantId.toHexString() === claims.tenantId &&
      record.specId.toHexString() === claims.specId &&
      record.userId === claims.userId &&
      record.role === claims.role;
    if (!matches) throw new InvalidSessionToken('unknown, revoked or mismatched session');
    return {
      tenantId: new Types.ObjectId(claims.tenantId),
      jti: claims.jti,
      specId: claims.specId,
      userId: claims.userId,
      role: claims.role,
    };
  }

  /** Revokes the caller's own session (logout); the token is refused from now on. */
  async revoke(session: SessionCaller): Promise<{ revoked: true }> {
    await this.model
      .updateOne(
        { _id: session.jti, tenantId: session.tenantId },
        { $set: { revokedAt: new Date() } },
      )
      .exec();
    return { revoked: true };
  }
}
