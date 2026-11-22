import { Type } from 'class-transformer';
import { IsDate, IsOptional } from 'class-validator';

/** GET /usage: an optional range, ISO 8601. Default: this calendar month (UTC) until now. */
export class UsageQueryDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
