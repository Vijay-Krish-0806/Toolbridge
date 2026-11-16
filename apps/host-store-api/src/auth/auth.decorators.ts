import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../domain/user.schema.js';

/** The signed-in staff member, attached to the request by AuthGuard. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

/** What the access token carries. `sub` (subject) is the standard JWT claim for the user id. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

/** The only request fields the guards need, so we do not depend on Express's types. */
export interface AuthedRequest {
  headers: { authorization?: string };
  user?: AuthUser;
}

export const IS_PUBLIC_KEY = 'isPublic';

/** Skips authentication for a route. Every other route requires a valid access token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the given roles. Routes without it are open to any signed-in role. */
export const Roles = Reflector.createDecorator<Role[]>();

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new Error('CurrentUser used on a route without AuthGuard');
  return user;
});
