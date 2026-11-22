import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Types } from 'mongoose';

import type { SessionCaller } from '../sessions/sessions.service.js';

/** Who is calling, attached by PlatformAuthGuard. Comes only from the API key, never from input. */
export interface Caller {
  tenantId: Types.ObjectId;
  keyId: string;
}

/** The only request fields the guard needs, so we do not depend on Express's types. */
export interface AuthedRequest {
  headers: { authorization?: string; origin?: string };
  /** Set for tenant API-key requests (the host's backend). */
  caller?: Caller;
  /** Set for session-token requests (a host user, Step 4.4b). */
  session?: SessionCaller;
}

export const IS_PUBLIC_KEY = 'isPublic';
export const IS_ADMIN_KEY = 'isAdmin';
export const IS_SESSION_ONLY = 'isSessionOnly';

/** Skips authentication (health check only). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The route accepts only the platform admin key, and never a tenant key. */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);

/**
 * The route accepts only a session token, never the tenant API key (Step 4.4b): runs and
 * approvals act FOR a host user, so the user and role must come from a verified token.
 */
export const SessionOnly = () => SetMetadata(IS_SESSION_ONLY, true);

/** The calling host user, from the session token. Use on @SessionOnly() routes. */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const session = context.switchToHttp().getRequest<AuthedRequest>().session;
  if (!session) throw new Error('CurrentSession used on a route without a session token');
  return session;
});

/** The calling tenant, from its API key. Use it for every tenant-data access. */
export const CurrentCaller = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = context.switchToHttp().getRequest<AuthedRequest>().caller;
  if (!caller) throw new Error('CurrentCaller used on a route without a tenant API key');
  return caller;
});
