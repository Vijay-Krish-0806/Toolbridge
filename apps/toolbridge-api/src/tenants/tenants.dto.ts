import { IsString, Length } from 'class-validator';

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
