import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { type ApiKey, MODEL } from '../domain/models.js';
import { adminKeyMatches, parseApiKey, secretMatches } from './api-key.js';
import { IS_ADMIN_KEY, IS_PUBLIC_KEY, type AuthedRequest } from './auth.decorators.js';

/**
 * Authentication for every route (registered globally, so a new route is protected by default).
 * - Admin routes accept only PLATFORM_ADMIN_KEY.
 * - All other routes accept only an active tenant API key, and the tenant it belongs to becomes
 *   the request's caller. Nothing in the URL or body can choose another tenant.
 * Every failure is the same 401, so callers cannot tell an unknown key from a wrong secret.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @InjectModel(MODEL.ApiKey.name) private readonly apiKeys: Model<ApiKey>,
  ) {}

  /** Lets the request through only with the right kind of valid key. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = (key: string): boolean =>
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (flag(IS_PUBLIC_KEY)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw this.denied();

    if (flag(IS_ADMIN_KEY)) {
      if (!adminKeyMatches(token, this.config.PLATFORM_ADMIN_KEY)) throw this.denied();
      return true;
    }

    const parsed = parseApiKey(token);
    if (!parsed) throw this.denied();
    // The only query not scoped to a tenant: we do not know the tenant until the key is checked.
    const key = await this.apiKeys
      .findOne({ _id: parsed.keyId, revokedAt: null })
      .lean<ApiKey>()
      .exec();
    if (!secretMatches(parsed.secret, key?.secretHash) || !key) throw this.denied();
    request.caller = { tenantId: key.tenantId, keyId: key._id };
    return true;
  }

  /** One message for every failure, on purpose. */
  private denied(): UnauthorizedException {
    return new UnauthorizedException('Missing, invalid or revoked API key.');
  }
}
