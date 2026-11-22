import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { MAX_SESSION_SECONDS } from './sessions.service.js';

/** POST /sessions: the host's backend asks for a session for one of its users. */
export class MintSessionDto {
  @IsString()
  specId!: string;

  /** The host's own user id; becomes the token's `sub`. */
  @IsString()
  @Length(1, 200)
  userId!: string;

  /** The user's role in the host; must be a role of the spec's policy. */
  @IsString()
  @Length(1, 100)
  role!: string;

  /** Lifetime in seconds: default 900 (15 min), at most 3600. */
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(MAX_SESSION_SECONDS)
  ttlSeconds?: number;

  /**
   * The user's own host API token, for user delegation (Step 4.4c). Stored envelope-encrypted
   * on the server, never returned, never put in the session token.
   */
  @IsOptional()
  @IsString()
  @Length(1, 8192)
  userToken?: string;
}
