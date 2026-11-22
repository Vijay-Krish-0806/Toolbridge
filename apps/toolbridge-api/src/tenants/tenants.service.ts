import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { generateApiKey } from '../auth/api-key.js';
import { normalizeOrigin } from '../auth/origins.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type ApiKey, type CredentialMode, MODEL, type Tenant } from '../domain/models.js';

/** What callers see about a key: never the secret or its hash. */
export interface ApiKeyView {
  keyId: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class TenantsService {
  constructor(
    @InjectModel(MODEL.Tenant.name) private readonly tenants: Model<Tenant>,
    @InjectModel(MODEL.ApiKey.name) private readonly apiKeys: Model<ApiKey>,
  ) {}

  /**
   * Admin only: creates a tenant and its first API key. The key is returned once and never again;
   * only its hash is stored.
   */
  async create(name: string): Promise<{ tenant: { id: string; name: string }; apiKey: string }> {
    const tenant = await new this.tenants({ name, createdAt: new Date() }).save();
    const token = await this.addKey(tenant._id, 'initial');
    return { tenant: { id: tenant._id.toHexString(), name }, apiKey: token };
  }

  /** The calling tenant's own record. */
  async get(tenantId: Types.ObjectId): Promise<{
    id: string;
    name: string;
    allowedOrigins: string[];
    credentialMode: CredentialMode;
  }> {
    const tenant = await this.tenants.findById(tenantId).lean<Tenant>().exec();
    if (!tenant) throw new NotFoundException('Tenant not found.');
    return {
      id: tenant._id.toHexString(),
      name: tenant.name,
      allowedOrigins: tenant.allowedOrigins,
      credentialMode: tenant.credentialMode,
    };
  }

  /**
   * Sets whose credential NEW runs use (Step 4.4c). Running and waiting runs keep the mode they
   * started with, so switching never changes the identity of a run half-way.
   */
  async setCredentialMode(
    tenantId: Types.ObjectId,
    mode: CredentialMode,
  ): Promise<{ credentialMode: CredentialMode }> {
    await this.tenants.updateOne({ _id: tenantId }, { $set: { credentialMode: mode } }).exec();
    return { credentialMode: mode };
  }

  /** The tenant's current mode (what a run starting now takes). */
  async credentialModeOf(tenantId: Types.ObjectId): Promise<CredentialMode> {
    const tenant = await this.tenants.findById(tenantId).lean<Tenant>().exec();
    return tenant?.credentialMode ?? 'service';
  }

  /**
   * Replaces the tenant's browser origins (Step 4.4b). Each must be a bare http(s) origin; a
   * path, a wildcard or anything else is refused (400), never "fixed" silently.
   * Before -> after: `['https://Shop.Example']` -> `{ allowedOrigins: ['https://shop.example'] }`.
   */
  async setOrigins(
    tenantId: Types.ObjectId,
    origins: string[],
  ): Promise<{ allowedOrigins: string[] }> {
    const normalized = origins.map((value) => {
      const origin = normalizeOrigin(value);
      if (!origin) {
        throw new BadRequestException(
          `"${value}" is not an origin; use scheme, host and port only, like https://shop.example.`,
        );
      }
      return origin;
    });
    const allowedOrigins = [...new Set(normalized)];
    await this.tenants.updateOne({ _id: tenantId }, { $set: { allowedOrigins } }).exec();
    return { allowedOrigins };
  }

  /** True when any tenant allows `origin` (a CORS preflight carries no token to say which). */
  async anyTenantAllows(origin: string): Promise<boolean> {
    return (await this.tenants.exists({ allowedOrigins: origin }).exec()) !== null;
  }

  /** True when this tenant allows `origin`. */
  async tenantAllows(tenantId: Types.ObjectId, origin: string): Promise<boolean> {
    return (await this.tenants.exists({ _id: tenantId, allowedOrigins: origin }).exec()) !== null;
  }

  /** Creates another key for the tenant (a tenant can hold several, for rotation). Returned once. */
  async createKey(tenantId: Types.ObjectId, label: string): Promise<{ apiKey: string }> {
    return { apiKey: await this.addKey(tenantId, label) };
  }

  /** The tenant's keys, newest first, without secrets. */
  async listKeys(tenantId: Types.ObjectId): Promise<ApiKeyView[]> {
    const keys = await this.scoped(tenantId).find({}, { createdAt: -1 });
    return keys.map(view);
  }

  /**
   * Revokes one of the tenant's keys. A key id of another tenant is "not found" (404), the same as
   * a key id that does not exist. Revoking the last active key is refused, so a tenant cannot lock
   * itself out.
   */
  async revokeKey(tenantId: Types.ObjectId, keyId: string): Promise<ApiKeyView> {
    const keys = this.scoped(tenantId);
    const key = await keys.findOne({ _id: keyId });
    if (!key) throw new NotFoundException('No such API key.');
    if (key.revokedAt === null && (await keys.countDocuments({ revokedAt: null })) <= 1) {
      throw new ConflictException('This is the last active key; create another key first.');
    }
    const revokedAt = key.revokedAt ?? new Date();
    await keys.updateOne({ _id: keyId }, { revokedAt });
    return view({ ...key, revokedAt });
  }

  /** Stores a new key's hash for the tenant and returns the full key string. */
  private async addKey(tenantId: Types.ObjectId, label: string): Promise<string> {
    const key = generateApiKey();
    await this.scoped(tenantId).insertOne({
      _id: key.keyId,
      secretHash: key.secretHash,
      label,
      createdAt: new Date(),
      revokedAt: null,
    } as Omit<ApiKey, '_id' | 'tenantId'>);
    return key.token;
  }

  /** The tenant's keys, through the scoped store. */
  private scoped(tenantId: Types.ObjectId): TenantScoped<ApiKey> {
    return new TenantScoped(mongooseCollection(this.apiKeys), tenantId);
  }
}

/** A key without its hash. */
function view(key: ApiKey): ApiKeyView {
  return { keyId: key._id, label: key.label, createdAt: key.createdAt, revokedAt: key.revokedAt };
}
