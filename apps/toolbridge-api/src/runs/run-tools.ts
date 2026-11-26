import { createHash } from 'node:crypto';

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
  hashArguments,
  KNOWLEDGE_TOOL_NAME,
  MEMORY_SAVE_TOOL,
  type ToolCall,
  ToolExecutor,
  ToolRegistry,
} from '@toolbridge/agent-core';
import type { MongoStore } from '@toolbridge/checkpoint-mongo';
import {
  createApprovalPolicy,
  createAuthorizer,
  findInstructions,
  type Policy,
} from '@toolbridge/policy';
import type { Types } from 'mongoose';

import { type AuditContext, AuditLog } from '../audit/audit-log.js';
import { OUTBOUND_HTTP } from '../common/core.module.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { CredentialMode, Spec } from '../domain/models.js';
import { MemoriesService } from '../memories/memories.service.js';
import { UserTokenStore } from '../sessions/user-token-store.js';
import { PoliciesService } from '../policies/policies.service.js';
import { KnowledgeService } from './knowledge.js';
import { Breakers, RateLimiter } from './rate-limiter.js';
import { SpecsService } from '../specs/specs.service.js';
import { ToolCache } from './tool-cache.js';

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
  /** The user's long-term memory (Step 4.7); left out when their role may not use it. */
  memory?: { store: MongoStore; namespace: string[] };
  /** Policy search is offered (ADR 0054): the prompt gets its rules, the answer's sources a check. */
  knowledge: boolean;
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
    private readonly rateLimiter: RateLimiter,
    private readonly breakers: Breakers,
    private readonly memories: MemoriesService,
    private readonly cache: ToolCache,
    private readonly knowledge: KnowledgeService,
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
      /** The user's message: needed for the memory tool, so left out when only checking. */
      message?: string;
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
        ...(connection.idempotencyHeader !== null && {
          idempotencyHeader: connection.idempotencyHeader,
        }),
      },
    );
    const registry = new ToolRegistry(tools);
    const authorizer = createAuthorizer(policy);

    // Step 4.7: long-term memory, for roles whose policy allows `memory_save` (deny by default, as
    // for every tool; without it nothing is recalled either). If the tenant's API has a tool of
    // that name, theirs stays and ours is left out, with its approval rule below.
    const owner = { tenantId, specId: spec._id, userId: principal.userId };
    const remembers =
      run.message !== undefined &&
      registry.get(MEMORY_SAVE_TOOL) === undefined &&
      authorizer.authorize(principal, MEMORY_SAVE_TOOL).allowed;
    if (remembers && run.message !== undefined) {
      registry.register(this.memories.tool(owner, run.message));
    }
    // ADR 0054: policy search, under the same rules: the role's policy must allow it, a tenant's own
    // tool of that name wins, and without documents it is not offered.
    const documents =
      registry.get(KNOWLEDGE_TOOL_NAME) === undefined &&
      authorizer.authorize(principal, KNOWLEDGE_TOOL_NAME).allowed
        ? await this.knowledge.tool(tenantId, spec._id)
        : undefined;
    if (documents) registry.register(documents);

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
    /** Delegated mode: the user whose token makes this call (the same choice as above). */
    const credentialUser = (callId: string): string | null =>
      approvedCalls.has(callId) ? (run.approval?.approverId ?? null) : principal.userId;
    return {
      registry,
      executor: new ToolExecutor(registry, {
        authorizer,
        // Step 4.5: stop calling an API that keeps failing, and keep each tenant within its rate.
        breaker: this.breakers.for(tenantId.toHexString(), spec._id.toHexString()),
        rateLimit: () => this.rateLimiter.take('tool-calls', tenantId.toHexString()),
        // Step 4.5: when the API supports keys, every write carries one derived from DURABLE
        // state (tenant, run, call id, arguments): the same on a retry, after a token refresh, a
        // change of identity or a worker takeover, so the API does the write once.
        ...(connection.idempotencyHeader !== null && {
          idempotencyKeyFor: (call: ToolCall) =>
            idempotencyKey(tenantId, run.runId, call.id, hashArguments(call.arguments)),
        }),
        ...(delegated && { credentialFor }),
        // Step 4.9: marks results that look like instructions, for the audit and the approval card.
        inspect: findInstructions,
        // Step 4.8: results are shared only between callers the API would answer the same: one
        // role in service mode, one user in delegated mode. An approved call runs as the APPROVER,
        // so its results are the approver's, not the requester's.
        cache: this.cache.for({ tenantId, spec, connection }, (callId) => ({
          mode: credential.mode,
          role: principal.role,
          userId: delegated ? credentialUser(callId) : null,
        })),
        audit: this.audit.auditorFor(tenantId, {
          runId: run.runId,
          actor: { kind: 'user', userId: principal.userId, role: principal.role },
          credentialMode: credential.mode,
          ...(delegated && { credentialUserFor: credentialUser }),
          policyVersion,
          ...(run.approval && { approval: run.approval }),
        }),
      }),
      access: { principal, authorizer },
      approvals: createApprovalPolicy(remembers ? withMemoryRule(policy) : policy),
      ...(remembers && { memory: this.memories.forRun(owner) }),
      knowledge: documents !== undefined,
    };
  }
}

/**
 * The policy plus "memory_save needs no approval": it stores only the user's own words, for that
 * user. Added as the LAST rule and the first match wins, so a tenant that wants a card for it just
 * writes a rule; a policy whose default is `required` would otherwise ask for every "remember...".
 */
function withMemoryRule(policy: Policy): Policy {
  const rule = { tools: [MEMORY_SAVE_TOOL], approval: 'none' as const };
  return {
    ...policy,
    approvals: { ...policy.approvals, rules: [...policy.approvals.rules, rule] },
  };
}

/**
 * A write's idempotency key: sha256 of who, which run, which call and which arguments. No
 * credential or time in it, so it never changes between attempts of the same call.
 * Before -> after: (tenant, 'run-3f2c', 'call_1', '9c1f…') -> 'tb-' + 64 hex characters.
 */
export function idempotencyKey(
  tenantId: Types.ObjectId,
  runId: string,
  callId: string,
  argsHash: string,
): string {
  const digest = createHash('sha256')
    .update(
      `${tenantId.toHexString()}
${runId}
${callId}
${argsHash}`,
    )
    .digest('hex');
  return `tb-${digest}`;
}
