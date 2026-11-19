import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { generateApiKey } from '../auth/api-key.js';
import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { type ApiKey, MODEL, type Tenant } from '../domain/models.js';

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
  async get(tenantId: Types.ObjectId): Promise<{ id: string; name: string }> {
    const tenant = await this.tenants.findById(tenantId).lean<Tenant>().exec();
    if (!tenant) throw new NotFoundException('Tenant not found.');
    return { id: tenant._id.toHexString(), name: tenant.name };
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
