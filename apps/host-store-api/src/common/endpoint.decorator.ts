import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public, Roles } from '../auth/auth.decorators.js';
import type { Role } from '../domain/user.schema.js';

interface EndpointOptions {
  summary: string;
  description: string;
  ok: new () => unknown;
  isArray?: boolean;
  /** Omit to allow every signed-in role. */
  roles?: Role[];
  /** Describe when the endpoint returns 404. */
  notFound?: string;
  public?: boolean;
}

/**
 * One decorator for both the access rule and its documentation. Because the role check and the
 * Swagger text come from the same `roles` value, the docs cannot drift from what is enforced.
 * ToolBridge reads these descriptions later, so they are written for an agent as much as a person.
 */
export function Endpoint(options: EndpointOptions) {
  const { summary, description, ok, isArray, roles, notFound } = options;
  const access = options.public
    ? 'No login needed.'
    : `Allowed roles: ${roles ? roles.join(', ') : 'any signed-in staff role'}.`;

  const decorators = [
    ApiOperation({ summary, description: `${description}\n\n${access}` }),
    ApiOkResponse({ type: ok, isArray }),
    ApiBadRequestResponse({ description: 'A query or path parameter is invalid.' }),
  ];
  if (options.public) {
    decorators.push(Public());
  } else {
    decorators.push(
      ApiBearerAuth(),
      ApiUnauthorizedResponse({ description: 'Missing, invalid or expired access token.' }),
    );
  }
  if (roles) {
    decorators.push(
      Roles(roles),
      ApiForbiddenResponse({
        description: `Signed in, but the role is not one of: ${roles.join(', ')}.`,
      }),
    );
  }
  if (notFound) decorators.push(ApiNotFoundResponse({ description: notFound }));
  return applyDecorators(...decorators);
}
