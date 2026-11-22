import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  type AuthProvider,
  type SafeHttpClient,
  StaticCredentials,
  TokenLogin,
} from '@toolbridge/agent-core';
import type { Model, Types } from 'mongoose';
import { Types as MongoTypes } from 'mongoose';

import { KEY_PROVIDER, OUTBOUND_HTTP } from '../common/core.module.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { DecryptionError, decryptSecret, encryptSecret, rewrapSecret } from '../crypto/envelope.js';
import type { KeyProvider } from '../crypto/key-provider.js';
import { type ApiConnection, MODEL } from '../domain/models.js';
import { SpecsService } from '../specs/specs.service.js';
import type { SetConnectionDto } from './connections.dto.js';

/** What callers may see about a connection: never secret values. */
export interface ConnectionView {
  baseUrl: string;
  authKind: ApiConnection['auth']['kind'];
  schemes: string[];
  loginPath: string | null;
  tokenField: string | null;
  hasSecret: boolean;
  /** Which master key version wraps the secret's data key (useful during rotation). */
  keyVersion: string | null;
  updatedAt: Date;
}

/** The decrypted form, only ever held in memory during one call. */
type SecretPayload = { secrets: Record<string, string> } | { loginFields: Record<string, string> };

/** The AAD that binds a connection's ciphertext to its tenant and record. */
export function connectionAad(tenantId: Types.ObjectId, connectionId: Types.ObjectId): string {
  return `tenant:${tenantId.toHexString()}:connection:${connectionId.toHexString()}`;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectModel(MODEL.ApiConnection.name) private readonly model: Model<ApiConnection>,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(OUTBOUND_HTTP) private readonly client: SafeHttpClient,
    private readonly specs: SpecsService,
  ) {}

  /**
   * Creates or replaces the spec's connection. The secret part is validated, then encrypted under
   * a fresh data key before anything is stored. The response is metadata only.
   */
  async set(
    tenantId: Types.ObjectId,
    specId: string,
    dto: SetConnectionDto,
  ): Promise<ConnectionView> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    const store = this.scoped(tenantId);
    const existing = await store.findOne({ specId: spec._id });
    const connectionId = existing?._id ?? new MongoTypes.ObjectId();
    const { auth, payload } = await this.validate(tenantId, spec._id.toHexString(), dto);
    const secret = payload
      ? encryptSecret(JSON.stringify(payload), connectionAad(tenantId, connectionId), this.keys)
      : null;

    const now = new Date();
    if (existing) {
      await store.updateOne(
        { _id: connectionId },
        { baseUrl: dto.baseUrl, auth, secret, updatedAt: now },
      );
      return view({ ...existing, baseUrl: dto.baseUrl, auth, secret, updatedAt: now });
    }
    const created = await store.insertOne({
      _id: connectionId,
      specId: spec._id,
      baseUrl: dto.baseUrl,
      auth,
      secret,
      createdAt: now,
      updatedAt: now,
    } as Omit<ApiConnection, '_id' | 'tenantId'>);
    return view(created);
  }

  /** The connection's metadata (no secrets), or 404. */
  async get(tenantId: Types.ObjectId, specId: string): Promise<ConnectionView> {
    return view(await this.require(tenantId, specId));
  }

  /** Deletes the connection, secret included. */
  async remove(tenantId: Types.ObjectId, specId: string): Promise<{ deleted: true }> {
    const connection = await this.require(tenantId, specId);
    await this.scoped(tenantId).deleteOne({ _id: connection._id });
    return { deleted: true };
  }

  /**
   * For a tool call: the base URL and an AuthProvider holding the decrypted secret. The plaintext
   * exists only inside the returned provider, for this one call (or one agent run). A secret
   * that does not decrypt becomes a fixed 500 message that never hints at which part failed.
   */
  async forCall(
    tenantId: Types.ObjectId,
    specId: Types.ObjectId,
  ): Promise<{ baseUrl: string; auth?: AuthProvider }> {
    const connection = await this.scoped(tenantId).findOne({ specId });
    if (!connection) {
      throw new ConflictException(
        'This spec has no connection yet; set one with PUT /specs/:id/connection.',
      );
    }
    const { baseUrl, auth, secret } = connection;
    if (auth.kind === 'none' || secret === null) return { baseUrl };
    let payload: SecretPayload;
    try {
      payload = JSON.parse(
        decryptSecret(secret, connectionAad(tenantId, connection._id), this.keys),
      ) as SecretPayload;
    } catch (error) {
      if (error instanceof DecryptionError) {
        // Usually the master key was changed without keeping the old one in
        // PLATFORM_PREVIOUS_MASTER_KEYS.
        throw new InternalServerErrorException(
          'The stored credential could not be decrypted; set the connection again.',
        );
      }
      throw error;
    }
    if ('secrets' in payload) return { baseUrl, auth: new StaticCredentials(payload.secrets) };
    return {
      baseUrl,
      auth: new TokenLogin({
        client: this.client,
        loginUrl: new URL(auth.loginPath ?? '/', baseUrl),
        credentials: payload.loginFields,
        tokenField: auth.tokenField ?? 'accessToken',
      }),
    };
  }

  /**
   * Admin, across all tenants: re-wraps every data key that is not on the current master key
   * version (after PLATFORM_MASTER_KEY changed and the old key moved to
   * PLATFORM_PREVIOUS_MASTER_KEYS). Secrets themselves are not re-encrypted. This and the API-key
   * lookup in the guard are the only deliberate queries outside TenantScoped.
   */
  async rewrapAll(): Promise<{ checked: number; rewrapped: number; currentVersion: string }> {
    const all = await this.model
      .find({ secret: { $ne: null } })
      .lean<ApiConnection[]>()
      .exec();
    let rewrapped = 0;
    for (const connection of all) {
      if (!connection.secret || connection.secret.dataKey.keyVersion === this.keys.currentVersion)
        continue;
      const secret = rewrapSecret(
        connection.secret,
        connectionAad(connection.tenantId, connection._id),
        this.keys,
      );
      await this.model
        .updateOne({ _id: connection._id, tenantId: connection.tenantId }, { $set: { secret } })
        .exec();
      rewrapped++;
    }
    return { checked: all.length, rewrapped, currentVersion: this.keys.currentVersion };
  }

  /**
   * Checks the auth settings against the spec and returns the metadata to store plus the secret
   * payload to encrypt. Static secrets must name security schemes the spec declares.
   */
  private async validate(
    tenantId: Types.ObjectId,
    specId: string,
    dto: SetConnectionDto,
  ): Promise<{ auth: ApiConnection['auth']; payload: SecretPayload | null }> {
    const none = { kind: dto.authKind, schemes: [], loginPath: null, tokenField: null };
    if (dto.authKind === 'none') return { auth: none, payload: null };

    if (dto.authKind === 'static') {
      const secrets = stringRecord(dto.secrets, 'secrets');
      const spec = await this.specs.requireSpec(tenantId, specId);
      const compiled = await this.specs.currentCompiled(tenantId, spec);
      const known = Object.keys(compiled.model.securitySchemes);
      const unknown = Object.keys(secrets).filter((name) => !known.includes(name));
      if (unknown.length > 0) {
        throw new UnprocessableEntityException(
          `Unknown security scheme(s): ${unknown.join(', ')}. This spec declares: ${known.join(', ') || '(none)'}.`,
        );
      }
      return { auth: { ...none, schemes: Object.keys(secrets) }, payload: { secrets } };
    }

    if (!dto.loginPath?.startsWith('/')) {
      throw new UnprocessableEntityException(
        'loginPath is required for login auth and must start with "/".',
      );
    }
    return {
      auth: { ...none, loginPath: dto.loginPath, tokenField: dto.tokenField ?? 'accessToken' },
      payload: { loginFields: stringRecord(dto.loginFields, 'loginFields') },
    };
  }

  /** The tenant's connection for a spec, or 404. */
  private async require(tenantId: Types.ObjectId, specId: string): Promise<ApiConnection> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    const connection = await this.scoped(tenantId).findOne({ specId: spec._id });
    if (!connection) throw new NotFoundException('This spec has no connection.');
    return connection;
  }

  /** The tenant's connections, through the scoped store. */
  private scoped(tenantId: Types.ObjectId): TenantScoped<ApiConnection> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }
}

/** A non-empty object of string values (secrets must be strings), or 422. */
function stringRecord(
  value: Record<string, unknown> | undefined,
  field: string,
): Record<string, string> {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0 || !entries.every(([, v]) => typeof v === 'string' && v !== '')) {
    throw new UnprocessableEntityException(`${field} must be a non-empty object of string values.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Metadata only. */
function view(connection: ApiConnection): ConnectionView {
  return {
    baseUrl: connection.baseUrl,
    authKind: connection.auth.kind,
    schemes: connection.auth.schemes,
    loginPath: connection.auth.loginPath,
    tokenField: connection.auth.tokenField,
    hasSecret: connection.secret !== null,
    keyVersion: connection.secret?.dataKey.keyVersion ?? null,
    updatedAt: connection.updatedAt,
  };
}
