import { Inject, Injectable } from '@nestjs/common';
import {
  type ApprovalPolicy,
  createOpenApiTools,
  type Principal,
  type RunAccess,
  type SafeHttpClient,
  ToolExecutor,
  ToolRegistry,
} from '@toolbridge/agent-core';
import { createApprovalPolicy, createAuthorizer } from '@toolbridge/policy';
import type { Types } from 'mongoose';

import { type AuditContext, AuditLog } from '../audit/audit-log.js';
import { OUTBOUND_HTTP, PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { Spec } from '../domain/models.js';
import { SpecsService } from '../specs/specs.service.js';

/** Everything a run needs besides the model and the checkpointer: tools, identity, rules. */
export interface RunTools {
  registry: ToolRegistry;
  executor: ToolExecutor;
  access: RunAccess;
  approvals: ApprovalPolicy;
}

/**
 * Builds a run's dependencies. LangGraph never saves these in a checkpoint (they are run
 * CONTEXT, not state), so they are built again from the database for every leg of a run: once
 * when it starts and once more when it resumes after an approval.
 *
 * Tools: the spec's current tools that the tenant has enabled and that are active (not in review,
 * not removed), calling the API with the spec's stored connection (credential mode `service`).
 * Access and approval rules: the platform policy file until Step 4.3b. The same authorizer is
 * given to the executor, so a forbidden call is refused even if it reached the executor
 * (defense in depth, Step 4.2). Every call is written to the audit log with this leg's run id,
 * user and (on a resumed leg) the decided approval; a write runs only after its row is saved.
 */
@Injectable()
export class RunToolsService {
  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(OUTBOUND_HTTP) private readonly client: SafeHttpClient,
    private readonly specs: SpecsService,
    private readonly connections: ConnectionsService,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Before -> after: (tenant, spec "store", { userId: 'u1', role: 'support' }) ->
   * a registry of the enabled tools, an executor that checks the support role on every call,
   * and the policy's approval rules.
   * Throws 409 when the spec has no connection, so a run that could never call a tool is refused
   * up front instead of failing in the background.
   */
  async build(
    tenantId: Types.ObjectId,
    spec: Spec,
    run: { runId: string; principal: Principal; approval?: AuditContext['approval'] },
  ): Promise<RunTools> {
    const { principal } = run;
    const compiled = await this.specs.currentCompiled(tenantId, spec);
    const settings = await this.specs.listTools(tenantId, spec._id.toHexString());
    const usable = new Set(
      settings.filter((t) => t.enabled && t.status === 'active').map((t) => t.name),
    );
    const connection = await this.connections.forCall(tenantId, spec._id);

    const tools = createOpenApiTools(
      compiled.tools.filter((t) => usable.has(t.name)),
      {
        baseUrl: connection.baseUrl,
        securitySchemes: compiled.model.securitySchemes,
        client: this.client,
        ...(connection.auth !== undefined && { auth: connection.auth }),
      },
    );
    const registry = new ToolRegistry(tools);
    const authorizer = createAuthorizer(this.config.policy);
    return {
      registry,
      executor: new ToolExecutor(registry, {
        authorizer,
        audit: this.audit.auditorFor(tenantId, {
          runId: run.runId,
          actor: { kind: 'user', userId: principal.userId, role: principal.role },
          credentialMode: 'service',
          ...(run.approval && { approval: run.approval }),
        }),
      }),
      access: { principal, authorizer },
      approvals: createApprovalPolicy(this.config.policy),
    };
  }
}
