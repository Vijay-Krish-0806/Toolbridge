import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** GET /audit filters. Every field is optional; dates are ISO 8601. */
export class AuditQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  runId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  toolName?: string;

  /** The host user the call was made for. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  userId?: string;

  @IsOptional()
  @IsMongoId()
  approvalId?: string;

  @IsOptional()
  @IsIn(['read', 'write'])
  safety?: 'read' | 'write';

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  /** Rows to return, newest first. Default 50, at most 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
