import { Body, Controller, Get, Param, Put } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { SetPolicyDto } from './policies.dto.js';
import { PoliciesService } from './policies.service.js';

/** A spec's role policy (Step 4.3b). Tenant from the API key only; another tenant's spec is 404. */
@Controller('specs/:specId/policy')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  /** Uploads a new version. Returns its number and warnings about names the spec lacks. */
  @Put()
  set(@CurrentCaller() caller: Caller, @Param('specId') specId: string, @Body() dto: SetPolicyDto) {
    return this.policies.set(caller.tenantId, caller.keyId, specId, dto.policy);
  }

  @Get()
  current(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.policies.current(caller.tenantId, specId);
  }

  @Get('versions')
  versions(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.policies.versions(caller.tenantId, specId);
  }
}
