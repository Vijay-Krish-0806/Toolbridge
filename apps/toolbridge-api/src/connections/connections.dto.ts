import { IsIn, IsObject, IsOptional, IsString, IsUrl, Length } from 'class-validator';

import type { AuthKind } from '../domain/models.js';

/**
 * Sets (or replaces) a spec's connection. Secrets are accepted here and never returned again.
 * - authKind "none": a public API.
 * - authKind "static": `secrets` maps security scheme names to values (bearer token, API key, or
 *   "user:password" for basic auth).
 * - authKind "login": `loginFields` (for example email and password) are POSTed as JSON to
 *   `loginPath`, and `tokenField` of the response is used as a bearer token.
 */
export class SetConnectionDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  baseUrl!: string;

  @IsIn(['none', 'static', 'login'])
  authKind!: AuthKind;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  loginPath?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  tokenField?: string;

  @IsOptional()
  @IsObject()
  loginFields?: Record<string, unknown>;
}

export class CallToolDto {
  /** The tool's arguments, as the tool's input schema describes them. */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;
}
