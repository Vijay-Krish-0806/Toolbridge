import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';

import type { ApprovalStatus } from '../domain/models.js';

/**
 * Who the run acts for: a host user id and their host role. Caller-supplied until Step 4.4b,
 * which takes both from a verified session token instead. The role is checked against the
 * policy on every tool (an unknown role gets no tools: deny by default).
 */
export class PrincipalDto {
  @IsString()
  @Length(1, 200)
  userId!: string;

  @IsString()
  @Length(1, 100)
  role!: string;
}

export class StartRunDto {
  @IsString()
  specId!: string;

  /** The user's request, for example "refund order ORD-10007 in full, it arrived damaged". */
  @IsString()
  @Length(1, 4000)
  message!: string;

  @ValidateNested()
  @Type(() => PrincipalDto)
  principal!: PrincipalDto;
}

/** Approve or reject. `approverId` is a host user id, caller-supplied until Step 4.4b. */
export class DecideApprovalDto {
  @IsString()
  @Length(1, 200)
  approverId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ListApprovalsQuery {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ApprovalStatus;
}
