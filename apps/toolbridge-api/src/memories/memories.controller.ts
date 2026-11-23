import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';

import { CurrentSession, SessionOnly } from '../auth/auth.decorators.js';
import type { SessionCaller } from '../sessions/sessions.service.js';
import { MemoriesService } from './memories.service.js';

/**
 * A user's own memories (Step 4.7). SESSION TOKENS ONLY: the tenant, spec and user come from the
 * verified token. Memories are created only by the agent's `memory_save` tool.
 */
@Controller('memories')
@SessionOnly()
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  /** What the assistant remembers about the signed-in user. */
  @Get()
  list(@CurrentSession() session: SessionCaller) {
    return this.memories.list(ownerOf(session));
  }

  /** Forgets one memory. */
  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentSession() session: SessionCaller, @Param('id') id: string): Promise<void> {
    return this.memories.remove(ownerOf(session), id);
  }
}

function ownerOf(session: SessionCaller) {
  return { tenantId: session.tenantId, specId: session.specId, userId: session.userId };
}
