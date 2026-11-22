import { ArrayMaxSize, IsArray, IsIn, IsString, Length } from 'class-validator';

import { MAX_ORIGINS } from '../auth/origins.js';

export class CreateTenantDto {
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class CreateApiKeyDto {
  /** What the key is for, for example "ci" or "mcp-server". */
  @IsString()
  @Length(1, 80)
  label!: string;
}

/** PUT /tenant/origins: the browser origins allowed to use this tenant's session tokens. */
export class SetOriginsDto {
  @IsArray()
  @ArrayMaxSize(MAX_ORIGINS)
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  origins!: string[];
}

/** PUT /tenant/credential-mode: whose credential this tenant's runs use (Step 4.4c). */
export class SetCredentialModeDto {
  @IsIn(['service', 'delegated'])
  mode!: 'service' | 'delegated';
}
