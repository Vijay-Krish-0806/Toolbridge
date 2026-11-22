import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';

import {
  CurrentCaller,
  CurrentSession,
  SessionOnly,
  type Caller,
} from '../auth/auth.decorators.js';
import { MintSessionDto } from './sessions.dto.js';
import { type SessionCaller, SessionsService } from './sessions.service.js';

/** Token exchange (Step 4.4b). */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** Tenant API key only (the host's backend): mints a session token for one host user. */
  @Post()
  mint(@CurrentCaller() caller: Caller, @Body() dto: MintSessionDto) {
    return this.sessions.mint(caller.tenantId, caller.keyId, dto);
  }

  /** Session token only: revokes the token used for this request (logout). */
  @Delete('current')
  @SessionOnly()
  @HttpCode(200)
  revoke(@CurrentSession() session: SessionCaller) {
    return this.sessions.revoke(session);
  }
}
