import { IsBoolean, IsObject, IsOptional, IsString, IsUrl, Length } from 'class-validator';

/** A new spec version: by URL or by uploaded JSON (exactly one), plus optional overrides. */
export class SpecVersionDto {
  /** http(s) URL of a JSON spec. Private addresses are refused unless the platform allows them. */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  url?: string;

  /** The spec itself, as JSON. */
  @IsOptional()
  @IsObject()
  document?: Record<string, unknown>;

  /** An overrides file (Step 2.2 format): hide, rename, risk, merge, result fields. */
  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;
}

export class RegisterSpecDto extends SpecVersionDto {
  /** Unique per tenant. */
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class SetToolDto {
  @IsBoolean()
  enabled!: boolean;
}
