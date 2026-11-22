import { Controller, Get, Query } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { AuditQueryDto } from './audit.dto.js';
import { AuditLog } from './audit-log.js';

/** The tenant's audit log, read-only. Tenant from the API key only. */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditLog) {}

  @Get()
  list(@CurrentCaller() caller: Caller, @Query() query: AuditQueryDto) {
    const { runId, toolName, userId, approvalId, safety, from, to } = query;
    return this.audit.query(caller.tenantId, {
      ...(runId !== undefined && { runId }),
      ...(toolName !== undefined && { toolName }),
      ...(userId !== undefined && { userId }),
      ...(approvalId !== undefined && { approvalId }),
      ...(safety !== undefined && { safety }),
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
      limit: query.limit ?? 50,
    });
  }
}
