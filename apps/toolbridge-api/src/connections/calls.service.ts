import { randomUUID } from 'node:crypto';

import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  createOpenApiTools,
  type SafeHttpClient,
  ToolExecutor,
  ToolRegistry,
  type ToolResult,
} from '@toolbridge/agent-core';
import type { Types } from 'mongoose';

import { OUTBOUND_HTTP } from '../common/core.module.js';
import { DecryptionError } from '../crypto/envelope.js';
import { SpecsService } from '../specs/specs.service.js';
import { ConnectionsService } from './connections.service.js';

/**
 * Runs one of a tenant's tools against its API (Step 2.3 executor and SSRF-safe client).
 * Defense in depth: the enable/review state is checked here, at call time, not only when tools
 * are listed. Tool failures (404 from the API, validation, timeouts) come back as results.
 */
@Injectable()
export class CallsService {
  constructor(
    private readonly specs: SpecsService,
    private readonly connections: ConnectionsService,
    @Inject(OUTBOUND_HTTP) private readonly client: SafeHttpClient,
  ) {}

  /** Calls `toolName` with `args` for the tenant, if the tool is allowed right now. */
  async call(
    tenantId: Types.ObjectId,
    specId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    const { compiled, setting } = await this.specs.toolForCall(tenantId, spec, toolName);
    const definition = compiled.tools.find((t) => t.name === toolName);
    if (!setting) throw new NotFoundException(`No tool named "${toolName}" in this spec.`);
    if (setting.status === 'removed' || !definition) {
      throw new ForbiddenException(`"${toolName}" is no longer in the spec.`);
    }
    if (setting.status === 'needs_review') {
      throw new ForbiddenException(
        `"${toolName}" changed in a breaking way; review it and enable it again before calling it.`,
      );
    }
    if (!setting.enabled)
      throw new ForbiddenException(`"${toolName}" is disabled for this tenant.`);

    let connection: Awaited<ReturnType<ConnectionsService['forCall']>>;
    try {
      connection = await this.connections.forCall(tenantId, spec._id);
    } catch (error) {
      if (error instanceof DecryptionError) {
        // Fixed message: never hint at which part failed. Usually the master key was changed
        // without keeping the old one in PLATFORM_PREVIOUS_MASTER_KEYS.
        throw new InternalServerErrorException(
          'The stored credential could not be decrypted; set the connection again.',
        );
      }
      throw error;
    }

    const tools = createOpenApiTools([definition], {
      baseUrl: connection.baseUrl,
      securitySchemes: compiled.model.securitySchemes,
      client: this.client,
      ...(connection.auth !== undefined && { auth: connection.auth }),
    });
    return new ToolExecutor(new ToolRegistry(tools)).run({
      id: randomUUID(),
      name: toolName,
      arguments: JSON.stringify(args),
    });
  }
}
