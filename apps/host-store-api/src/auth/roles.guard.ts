import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../domain/user.schema.js';
import { Roles, type AuthedRequest } from './auth.decorators.js';

/**
 * Authorization (are you allowed?). Runs after AuthGuard, so the user is already known.
 * Failing here returns 403 Forbidden: the caller is signed in but lacks the role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Read by key with an explicit type: the value is undefined on routes without @Roles.
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(Roles.KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) return true;

    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !allowed.includes(user.role)) {
      throw new ForbiddenException(`This action needs one of these roles: ${allowed.join(', ')}.`);
    }
    return true;
  }
}
