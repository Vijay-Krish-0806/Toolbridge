import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';

import { AdminOnly, CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import {
  CreateApiKeyDto,
  CreateTenantDto,
  SetBudgetDto,
  SetCredentialModeDto,
  SetOriginsDto,
} from './tenants.dto.js';
import { type ApiKeyView, TenantsService } from './tenants.service.js';

/** Platform administration: creating tenants. Admin key only. */
@Controller('admin/tenants')
@AdminOnly()
export class AdminTenantsController {
  constructor(private readonly tenants: TenantsService) {}

  /** Creates a tenant and returns its first API key (shown once). */
  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.tenants.create(dto.name);
  }
}

/** The calling tenant's own account and API keys. */
@Controller()
export class TenantController {
  constructor(private readonly tenants: TenantsService) {}

  /** Which tenant this key belongs to. */
  @Get('me')
  me(@CurrentCaller() caller: Caller) {
    return this.tenants.get(caller.tenantId);
  }

  /** The browser origins (host web apps) allowed to use this tenant's session tokens. */
  @Put('tenant/origins')
  setOrigins(@CurrentCaller() caller: Caller, @Body() dto: SetOriginsDto) {
    return this.tenants.setOrigins(caller.tenantId, dto.origins);
  }

  /** service (the stored key) or delegated (each user's own host token) for new runs. */
  @Put('tenant/credential-mode')
  setCredentialMode(@CurrentCaller() caller: Caller, @Body() dto: SetCredentialModeDto) {
    return this.tenants.setCredentialMode(caller.tenantId, dto.mode);
  }

  /** Tokens per calendar month (UTC) for new runs, or null for no limit (Step 4.6). */
  @Put('tenant/budget')
  setBudget(@CurrentCaller() caller: Caller, @Body() dto: SetBudgetDto) {
    return this.tenants.setMonthlyTokenBudget(caller.tenantId, dto.monthlyTokenBudget);
  }

  @Get('api-keys')
  listKeys(@CurrentCaller() caller: Caller): Promise<ApiKeyView[]> {
    return this.tenants.listKeys(caller.tenantId);
  }

  /** A new key (for rotation: create the new one, switch clients, revoke the old one). */
  @Post('api-keys')
  createKey(@CurrentCaller() caller: Caller, @Body() dto: CreateApiKeyDto) {
    return this.tenants.createKey(caller.tenantId, dto.label);
  }

  @Delete('api-keys/:keyId')
  @HttpCode(200)
  revokeKey(@CurrentCaller() caller: Caller, @Param('keyId') keyId: string): Promise<ApiKeyView> {
    return this.tenants.revokeKey(caller.tenantId, keyId);
  }
}
