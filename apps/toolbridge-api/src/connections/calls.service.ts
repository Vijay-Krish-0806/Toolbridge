import { randomUUID } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  createOpenApiTools,
  type SafeHttpClient,
  ToolExecutor,
  ToolRegistry,
  type ToolResult,
} from '@toolbridge/agent-core';
import { findInstructions } from '@toolbridge/policy';
import type { Types } from 'mongoose';

import { AuditLog } from '../audit/audit-log.js';
import { OUTBOUND_HTTP } from '../common/core.module.js';
import { ToolCache } from '../runs/tool-cache.js';
import { SpecsService } from '../specs/specs.service.js';
import { ConnectionsService } from './connections.service.js';

/**
 * Runs one of a tenant's tools against its API (Step 2.3 executor and SSRF-safe client).
 * Defense in depth: the enable/review state is checked here, at call time, not only when tools
 * are listed. Tool failures (404 from the API, validation, timeouts) come back as results.
 * Every call is audited with the API key as the actor: these calls have no user and no approval
 * (v3 list: require approval for writes here).
 */
@Injectable()
export class CallsService {
  constructor(
    private readonly specs: SpecsService,
    private readonly connections: ConnectionsService,
    @Inject(OUTBOUND_HTTP) private readonly client: SafeHttpClient,
    private readonly audit: AuditLog,
    private readonly cache: ToolCache,
  ) {}

  /** Calls `toolName` with `args` for the tenant, if the tool is allowed right now. */
  async call(
    tenantId: Types.ObjectId,
    keyId: string,
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

    const connection = await this.connections.forCall(tenantId, spec._id);

    const tools = createOpenApiTools([definition], {
      baseUrl: connection.baseUrl,
      securitySchemes: compiled.model.securitySchemes,
      client: this.client,
      ...(connection.auth !== undefined && { auth: connection.auth }),
      ...(connection.idempotencyHeader !== null && {
        idempotencyHeader: connection.idempotencyHeader,
      }),
    });
    const callId = randomUUID();
    const audit = this.audit.auditorFor(tenantId, {
      runId: null,
      actor: { kind: 'api_key', keyId },
      credentialMode: 'service',
      policyVersion: null, // direct calls have no role, so no role policy applies
    });
    // A direct call is its own unit: its key covers the executor's retries of this one request.
    const keyed = connection.idempotencyHeader !== null;
    return new ToolExecutor(new ToolRegistry(tools), {
      audit,
      inspect: findInstructions,
      // Step 4.8: no identity, so reads are never cached; a write still invalidates the runs' cache.
      cache: this.cache.for({ tenantId, spec, connection }),
      ...(keyed && { idempotencyKeyFor: () => `tb-direct-${callId}` }),
    }).run({
      id: callId,
      name: toolName,
      arguments: JSON.stringify(args),
    });
  }
}
