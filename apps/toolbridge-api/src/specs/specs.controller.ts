import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { RegisterSpecDto, SetToolDto, SpecVersionDto } from './specs.dto.js';
import { SpecsService } from './specs.service.js';

/**
 * A tenant's specs and tools. The tenant always comes from the API key (CurrentCaller), never
 * from the URL: `:specId` is looked up inside the caller's own data only.
 */
@Controller('specs')
export class SpecsController {
  constructor(private readonly specs: SpecsService) {}

  /** Registers a spec (version 1) by URL or upload. */
  @Post()
  register(@CurrentCaller() caller: Caller, @Body() dto: RegisterSpecDto) {
    return this.specs.register(caller.tenantId, dto.name, dto);
  }

  @Get()
  list(@CurrentCaller() caller: Caller) {
    return this.specs.list(caller.tenantId);
  }

  @Get(':specId')
  get(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.specs.get(caller.tenantId, specId);
  }

  /** Uploads a new version; returns the diff summary and what happened to the tools. */
  @Post(':specId/versions')
  addVersion(
    @CurrentCaller() caller: Caller,
    @Param('specId') specId: string,
    @Body() dto: SpecVersionDto,
  ) {
    return this.specs.addVersion(caller.tenantId, specId, dto);
  }

  @Get(':specId/tools')
  listTools(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.specs.listTools(caller.tenantId, specId);
  }

  /** Enables or disables one tool. */
  @Patch(':specId/tools/:toolName')
  setTool(
    @CurrentCaller() caller: Caller,
    @Param('specId') specId: string,
    @Param('toolName') toolName: string,
    @Body() dto: SetToolDto,
  ) {
    return this.specs.setTool(caller.tenantId, specId, toolName, dto.enabled);
  }
}
