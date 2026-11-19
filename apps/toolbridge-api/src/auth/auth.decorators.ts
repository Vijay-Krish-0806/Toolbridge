import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Types } from 'mongoose';

/** Who is calling, attached by PlatformAuthGuard. Comes only from the API key, never from input. */
export interface Caller {
  tenantId: Types.ObjectId;
  keyId: string;
}

/** The only request fields the guard needs, so we do not depend on Express's types. */
export interface AuthedRequest {
  headers: { authorization?: string };
  caller?: Caller;
}

export const IS_PUBLIC_KEY = 'isPublic';
export const IS_ADMIN_KEY = 'isAdmin';

/** Skips authentication (health check only). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The route accepts only the platform admin key, and never a tenant key. */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);

/** The calling tenant, from its API key. Use it for every tenant-data access. */
export const CurrentCaller = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = context.switchToHttp().getRequest<AuthedRequest>().caller;
  if (!caller) throw new Error('CurrentCaller used on a route without a tenant API key');
  return caller;
});
