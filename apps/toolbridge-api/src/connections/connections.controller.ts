import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';

import { AdminOnly, CurrentCaller, type Caller } from '../auth/auth.decorators.js';
import { CallsService } from './calls.service.js';
import { CallToolDto, SetConnectionDto } from './connections.dto.js';
import { ConnectionsService } from './connections.service.js';

/** A spec's connection (write-only secrets) and calling its tools. Tenant from the API key only. */
@Controller('specs/:specId')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly calls: CallsService,
  ) {}

  /** Creates or replaces the connection; secrets are encrypted and never returned. */
  @Put('connection')
  set(
    @CurrentCaller() caller: Caller,
    @Param('specId') specId: string,
    @Body() dto: SetConnectionDto,
  ) {
    return this.connections.set(caller.tenantId, specId, dto);
  }

  @Get('connection')
  get(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.connections.get(caller.tenantId, specId);
  }

  @Delete('connection')
  @HttpCode(200)
  remove(@CurrentCaller() caller: Caller, @Param('specId') specId: string) {
    return this.connections.remove(caller.tenantId, specId);
  }

  /** Calls one enabled tool; the result (success or the API's error) is in the body. */
  @Post('tools/:toolName/call')
  @HttpCode(200)
  call(
    @CurrentCaller() caller: Caller,
    @Param('specId') specId: string,
    @Param('toolName') toolName: string,
    @Body() dto: CallToolDto,
  ) {
    return this.calls.call(caller.tenantId, caller.keyId, specId, toolName, dto.arguments ?? {});
  }
}

/** Master-key rotation: re-wrap every data key that is not on the current key version. */
@Controller('admin/connections')
@AdminOnly()
export class AdminConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post('rewrap')
  @HttpCode(200)
  rewrap() {
    return this.connections.rewrapAll();
  }
}
