import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { type ApiKey, MODEL } from '../domain/models.js';
import { parseApiKey, secretMatches } from './api-key.js';
import type { Caller } from './auth.decorators.js';

/**
 * Checks a tenant API key: the guard uses it for every key request, and the dev-only login page
 * for the key typed into its form. One place, so both apply exactly the same rules.
 */
@Injectable()
export class ApiKeyVerifier {
  constructor(@InjectModel(MODEL.ApiKey.name) private readonly apiKeys: Model<ApiKey>) {}

  /** The key's tenant, or null for a malformed, unknown, revoked or wrong key. */
  async verify(token: string): Promise<Caller | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    // The only query not scoped to a tenant: we do not know the tenant until the key is checked.
    const key = await this.apiKeys
      .findOne({ _id: parsed.keyId, revokedAt: null })
      .lean<ApiKey>()
      .exec();
    if (!secretMatches(parsed.secret, key?.secretHash) || !key) return null;
    return { tenantId: key.tenantId, keyId: key._id };
  }
}
