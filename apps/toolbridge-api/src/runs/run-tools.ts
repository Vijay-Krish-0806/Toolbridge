import { Inject, Injectable } from '@nestjs/common';
import {
  type ApprovalPolicy,
  type AuthProvider,
  createOpenApiTools,
  CredentialUnavailableError,
  type Principal,
  type RunAccess,
  type SafeHttpClient,
  StaticCredentials,
  type ToolCall,
  ToolExecutor,
  ToolRegistry,
} from '@toolbridge/agent-core';
import { createApprovalPolicy, createAuthorizer } from '@toolbridge/policy';
import type { Types } from 'mongoose';

import { type AuditContext, AuditLog } from '../audit/audit-log.js';
import { OUTBOUND_HTTP } from '../common/core.module.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { CredentialMode, Spec } from '../domain/models.js';
import { UserTokenStore } from '../sessions/user-token-store.js';
import { PoliciesService } from '../policies/policies.service.js';
import { SpecsService } from '../specs/specs.service.js';

/**
 * Whose credential a run uses (Step 4.4c). In delegated mode, the requester's session holds the
 * host token for the run's calls, and the approver's session for the calls of the card they
 * approved (ADR 0028, option 0).
 */
export interface RunCredential {
  mode: CredentialMode;
  requesterSession: string | null;
  approverSession?: string | null;
}

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
 * Access and approval rules: the spec's current stored policy (Step 4.3b), or deny-all when it
 * has none, so a spec without a policy offers and runs no tools. The same authorizer is
 * given to the executor, so a forbidden call is refused even if it reached the executor
 * (defense in depth, Step 4.2). Every call is written to the audit log with this leg's run id,
 * user and (on a resumed leg) the decided approval; a write runs only after its row is saved.
 */
@Injectable()
export class RunToolsService {
  constructor(
    @Inject(OUTBOUND_HTTP) private readonly client: SafeHttpClient,
    private readonly specs: SpecsService,
    private readonly connections: ConnectionsService,
    private readonly audit: AuditLog,
    private readonly policies: PoliciesService,
    private readonly userTokens: UserTokenStore,
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
    run: {
      runId: string;
      principal: Principal;
      approval?: AuditContext['approval'];
      credential?: RunCredential;
    },
  ): Promise<RunTools> {
    const { principal } = run;
    const credential = run.credential ?? { mode: 'service', requesterSession: null };
    const compiled = await this.specs.currentCompiled(tenantId, spec);
    const settings = await this.specs.listTools(tenantId, spec._id.toHexString());
    const usable = new Set(
      settings.filter((t) => t.enabled && t.status === 'active').map((t) => t.name),
    );
    const connection = await this.connections.forCall(tenantId, spec._id);
    const { policy, version: policyVersion } = await this.policies.forRun(tenantId, spec);

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
    const authorizer = createAuthorizer(policy);
    const approvedCalls = new Set(run.approval?.calls.map((c) => c.id) ?? []);
    const delegated = credential.mode === 'delegated';
    const bearerSchemes = Object.entries(compiled.model.securitySchemes)
      .filter(([, scheme]) => scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer')
      .map(([name]) => name);

    /**
     * Delegated mode: the call's own credential. An approved call runs as the approver, every
     * other call as the requester. A session that has ended (expired, logged out) refuses the
     * call; nothing ever falls back to the service credential.
     */
    const credentialFor = async (call: ToolCall): Promise<AuthProvider> => {
      const asApprover = approvedCalls.has(call.id);
      const jti = asApprover ? credential.approverSession : credential.requesterSession;
      const found = jti ? await this.userTokens.tokenFor(tenantId, jti) : null;
      if (!found) {
        throw new CredentialUnavailableError(
          asApprover ? "The approver's session has ended." : "The user's session has ended.",
        );
      }
      // The user's token stands in for the service credential on every bearer scheme of the API.
      return new StaticCredentials(Object.fromEntries(bearerSchemes.map((n) => [n, found.token])));
    };
    return {
      registry,
      executor: new ToolExecutor(registry, {
        authorizer,
        ...(delegated && { credentialFor }),
        audit: this.audit.auditorFor(tenantId, {
          runId: run.runId,
          actor: { kind: 'user', userId: principal.userId, role: principal.role },
          credentialMode: credential.mode,
          ...(delegated && {
            credentialUserFor: (callId: string) =>
              approvedCalls.has(callId) ? (run.approval?.approverId ?? null) : principal.userId,
          }),
          policyVersion,
          ...(run.approval && { approval: run.approval }),
        }),
      }),
      access: { principal, authorizer },
      approvals: createApprovalPolicy(policy),
    };
  }
}
