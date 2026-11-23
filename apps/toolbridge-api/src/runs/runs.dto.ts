import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import type { ApprovalStatus } from '../domain/models.js';

/**
 * POST /runs. Only the message (and which conversation it continues): the user, role and spec come from the session token (Step
 * 4.4b). A `principal` or `specId` in the body is refused (400), so a browser can never pick
 * its own role.
 */
export class StartRunDto {
  /** The user's request, for example "refund order ORD-10007 in full, it arrived damaged". */
  @IsString()
  @Length(1, 4000)
  message!: string;

  /**
   * Continue this conversation (Step 4.7), from an earlier response. Left out: a new one starts.
   * Only a conversation of the same user, role and spec is accepted; anything else is 404.
   */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

/** Approve or reject. The approver is the session's user; only a reason may be given. */
export class DecideApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ListApprovalsQuery {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'cancelled'])
  status?: ApprovalStatus;
}
