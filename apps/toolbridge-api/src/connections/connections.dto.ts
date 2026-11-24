import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

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

  /**
   * Step 4.5: the header this API reads an idempotency key from, if it supports keys (for
   * example `Idempotency-Key`). Then every write carries a key derived from the run, so a
   * retried or taken-over write is done once by the API. Omit when the API has no such support.
   */
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, { message: 'idempotencyHeader must be a header name' })
  idempotencyHeader?: string;

  /**
   * Step 4.8: how long the result of a read may be reused, in seconds (at most 5 minutes). Writes
   * through the platform end it at once; changes made elsewhere (your own UI) are noticed only
   * when the time is over. Omit, or 0, for no caching.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  cacheTtlSeconds?: number;
}

export class CallToolDto {
  /** The tool's arguments, as the tool's input schema describes them. */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;
}
