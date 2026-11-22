import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { looksLikeJwt } from '../sessions/session-token.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { adminKeyMatches } from './api-key.js';
import { ApiKeyVerifier } from './api-key-verifier.js';
import {
  IS_ADMIN_KEY,
  IS_PUBLIC_KEY,
  IS_SESSION_ONLY,
  type AuthedRequest,
} from './auth.decorators.js';
import { corsHeaders, normalizeOrigin } from './origins.js';

/** The response fields the guard sets (CORS headers), without depending on Express's types. */
interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Authentication for every route (registered globally, so a new route is protected by default).
 * - Admin routes accept only PLATFORM_ADMIN_KEY.
 * - @SessionOnly() routes (runs, approvals) accept only a session token (Step 4.4b): the token's
 *   tenant, user and role become the request's session. Nothing in the body can choose them.
 * - All other routes accept only an active tenant API key, and the tenant it belongs to becomes
 *   the request's caller. Nothing in the URL or body can choose another tenant.
 * Every failure is the same 401, so callers cannot tell an unknown key from a wrong secret, or a
 * forged token from an expired one.
 *
 * BROWSERS (Step 4.4b): a request with an `Origin` header comes from a web page.
 * - A key (tenant or admin) from a browser is refused (403): keys belong on servers only.
 * - A session token is accepted only from an origin that the token's OWN tenant allows; the
 *   response then carries the CORS headers that let that page read it.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    private readonly keys: ApiKeyVerifier,
    private readonly sessions: SessionsService,
    private readonly tenants: TenantsService,
  ) {}

  /** Lets the request through only with the right kind of valid credential. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = (key: string): boolean =>
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (flag(IS_PUBLIC_KEY)) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const origin = request.headers.origin;
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw this.denied();

    if (flag(IS_SESSION_ONLY)) {
      if (!looksLikeJwt(token)) throw this.denied();
      try {
        request.session = await this.sessions.resolve(token);
      } catch {
        throw this.denied();
      }
      if (origin !== undefined) {
        const allowed = normalizeOrigin(origin);
        if (!allowed || !(await this.tenants.tenantAllows(request.session.tenantId, allowed))) {
          throw new ForbiddenException('This origin is not allowed for this tenant.');
        }
        const response = http.getResponse<HeaderResponse>();
        for (const [name, value] of Object.entries(corsHeaders(allowed))) {
          response.setHeader(name, value);
        }
      }
      return true;
    }

    // Everything below takes a key, which must never be in a web page.
    if (origin !== undefined) {
      throw new ForbiddenException('API keys must never be used from a browser.');
    }
    if (flag(IS_ADMIN_KEY)) {
      if (!adminKeyMatches(token, this.config.PLATFORM_ADMIN_KEY)) throw this.denied();
      return true;
    }
    const caller = await this.keys.verify(token);
    if (!caller) throw this.denied();
    request.caller = caller;
    return true;
  }

  /** One message for every failure, on purpose. */
  private denied(): UnauthorizedException {
    return new UnauthorizedException('Missing, invalid, expired or revoked credentials.');
  }
}
