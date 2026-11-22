/**
 * Platform data. Pool model (ADR 0019): one database, and every tenant-owned document carries
 * `tenantId`, with every index starting with it, so each tenant's queries stay on its own slice.
 */
import { type Connection, Schema, type Types } from 'mongoose';

import type { AgentUsage, ApprovalRequest, PendingCall, Principal } from '@toolbridge/agent-core';
import type { RiskLevel, SafetyClass } from '@toolbridge/spec-compiler';

import type { EncryptedSecret } from '../crypto/envelope.js';

export interface Tenant {
  _id: Types.ObjectId;
  name: string;
  /**
   * Browser origins allowed to call the run API with this tenant's session tokens (Step 4.4b),
   * for example the host app's web address. Empty: no browser access at all.
   */
  allowedOrigins: string[];
  /** Whose credential runs use (Step 4.4c); new runs take it at start. Default `service`. */
  credentialMode: CredentialMode;
  createdAt: Date;
}

/**
 * An API key. `_id` is the public key id (part of the key string), so the guard looks a key up by
 * id and then compares only the secret's hash. The secret itself is never stored.
 */
export interface ApiKey {
  _id: string;
  tenantId: Types.ObjectId;
  /** sha256 of the secret part, hex. */
  secretHash: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export type SpecSourceKind = 'upload' | 'url';

export interface Spec {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  source: { kind: SpecSourceKind; url: string | null };
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Summary of the diff from the previous version (Step 2.4), or null for version 1. */
export interface VersionDiff {
  added: number;
  removed: number;
  changed: number;
  breaking: boolean;
}

export interface SpecVersion {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  version: number;
  /** Key of the compiled result in the content-addressed cache. */
  compileKey: string;
  specHash: string;
  overridesHash: string;
  toolCount: number;
  warningCount: number;
  diff: VersionDiff | null;
  createdAt: Date;
}

/**
 * active: usable if enabled. needs_review: a write tool whose operation changed in a breaking way;
 * disabled until someone enables it again. removed: no longer in the spec; cannot be enabled.
 */
export type ToolStatus = 'active' | 'needs_review' | 'removed';

export interface ToolSetting {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  name: string;
  enabled: boolean;
  status: ToolStatus;
  safety: SafetyClass;
  risk: RiskLevel;
  updatedAt: Date;
}

export type AuthKind = 'none' | 'static' | 'login';

/**
 * Where a spec's API lives and how to authenticate to it. One per spec. `auth` holds only
 * non-secret metadata; every secret value is inside `secret`, envelope-encrypted with
 * AAD "tenant:<tenantId>:connection:<_id>".
 */
export interface ApiConnection {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  baseUrl: string;
  auth: {
    kind: AuthKind;
    /** static: the security scheme names that have a secret (not the secrets). */
    schemes: string[];
    /** login: where to post the credentials and which response field holds the token. */
    loginPath: string | null;
    tokenField: string | null;
  };
  secret: EncryptedSecret | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * running: queued or executing on a worker. waiting_for_approval: paused on an approval card
 * (its checkpoint is in MongoDB). completed: the graph finished. failed: it threw on every
 * attempt, or hit its time limit. cancelled: stopped on request.
 */
export type RunStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';

/**
 * Whose credential a run's tool calls use (ADRs 0027, 0028, 0038):
 * - `service`: the spec's stored connection (one account for every user);
 * - `delegated`: each user's own host token (Step 4.4c), so the host applies its own rules to
 *   that user. An approved write uses the APPROVER's token. Recorded on every run and audit row.
 */
export type CredentialMode = 'service' | 'delegated';

/**
 * One agent run (Step 4.3). `_id` is a UUID and is also LangGraph's `thread_id`, the key of the
 * run's checkpoints. The principal is stored here because LangGraph never checkpoints the run
 * context: a resume must supply the same identity again, and it comes from this record.
 */
export interface Run {
  _id: string;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  message: string;
  principal: Principal;
  credentialMode: CredentialMode;
  /** The requester's session (its jti): in delegated mode, whose host token the calls use. */
  requesterSession: string | null;
  status: RunStatus;
  /** The open (or last) approval of this run. */
  approvalId: Types.ObjectId | null;
  answer: string | null;
  stopReason: string | null;
  usage: AgentUsage | null;
  /** Why the run failed, for people; never a stack trace. */
  error: string | null;
  /** Set by POST /runs/:id/cancel; the worker running the leg stops it (Step 4.4a). */
  cancelRequested: boolean;
  /** The last event sequence number used; incremented atomically for each new event. */
  eventSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

/** cancelled: the run was cancelled while the card was pending, so it can no longer be decided. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * One approval card: a paused model turn with every call and its exact arguments. Created by the
 * API when it sees the pause (outside the graph, so the graph's approval node stays side-effect
 * free). Decided exactly once: the pending -> decided change is one atomic update.
 */
export interface Approval {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  runId: string;
  /** The run's spec: approvers see only cards of the spec their session is for (Step 4.4b). */
  specId: Types.ObjectId;
  status: ApprovalStatus;
  /** The strictest level in the turn; `high` means the requester may not approve it. */
  level: ApprovalRequest['level'];
  requesterId: string;
  calls: PendingCall[];
  approverId: string | null;
  /** The approver's session (its jti): in delegated mode the approved calls use its host token. */
  approverSession: string | null;
  reason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/**
 * One uploaded version of a spec's role policy (Step 4.3b, ADR 0033). APPEND-ONLY: every upload
 * inserts a new version and nothing is ever changed or deleted, so the versions are also the
 * audit trail of policy changes. The current policy is the highest version; a spec with no
 * version at all denies every tool.
 */
export interface PolicyVersion {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  version: number;
  /**
   * The validated policy as JSON text. Text, not a nested document: role names may contain
   * characters (such as "." or "$") that MongoDB does not allow in field names.
   */
  document: string;
  /** sha256 of `document`, to compare versions at a glance. */
  policyHash: string;
  /** The spec version the policy was checked against when uploaded ("tied to the spec version"). */
  specVersion: number;
  /** Who uploaded it: the tenant API key (no user identity on this API until Step 4.4b). */
  createdBy: { kind: 'api_key'; keyId: string };
  createdAt: Date;
}

/**
 * One public event of a run (Step 4.4a, packages/run-events). `seq` is 1, 2, 3, … per run with
 * no gaps, so a client that reconnects asks for "everything after seq N" and misses nothing.
 */
export interface RunEventRecord {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  runId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: Date;
}

/**
 * One session token's server-side record (Step 4.4b, ADR 0036), keyed by the token's `jti`.
 * The token itself (a signed JWT) holds tenant, spec, user and role; this record lets a token be
 * revoked before it expires, and holds what must never be in a browser: the host user's own
 * API token, envelope-encrypted (used from Step 4.4c). MongoDB deletes the record when it expires.
 */
export interface Session {
  _id: string;
  tenantId: Types.ObjectId;
  specId: Types.ObjectId;
  userId: string;
  role: string;
  /** Who minted it: the tenant API key (the host's backend) or the dev login page. */
  mintedBy: { kind: 'api_key'; keyId: string };
  expiresAt: Date;
  revokedAt: Date | null;
  userToken: EncryptedSecret | null;
  createdAt: Date;
}

/** Who a tool call was made for: a host user (agent runs), or a tenant API key (direct calls). */
export type AuditActor =
  { kind: 'user'; userId: string; role: string } | { kind: 'api_key'; keyId: string };

/**
 * One audit row (Step 4.10, ADR 0032). APPEND-ONLY: the platform only inserts and reads these.
 * A write gets two rows: `started` (saved before the write runs; if it cannot be saved, the
 * write does not run) and `finished`. A read or a refused call gets only `finished`.
 * `argsHash` is sha256 of the exact argument string, so it can be compared with the approval card
 * without storing customer data here.
 */
export interface AuditEntry {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  at: Date;
  phase: 'started' | 'finished';
  /** null for direct tool calls (no agent run). */
  runId: string | null;
  callId: string;
  toolName: string;
  safety: SafetyClass | null;
  actor: AuditActor;
  credentialMode: CredentialMode;
  /** Delegated mode: the host user whose own token made the call (requester or approver). */
  credentialUserId: string | null;
  argsHash: string;
  /** `ok` or the error code; null on a `started` row. */
  status: string | null;
  durationMs: number | null;
  /** The spec's policy version that authorized the call; null when the spec had no policy. */
  policyVersion: number | null;
  /** The approval that let this call run, or null (reads, refusals, direct calls). */
  approval: {
    id: Types.ObjectId;
    level: ApprovalRequest['level'];
    requesterId: string;
    approverId: string;
  } | null;
}

const tenantSchema = new Schema<Tenant>({
  name: { type: String, required: true },
  allowedOrigins: { type: [String], default: [] },
  credentialMode: { type: String, enum: ['service', 'delegated'], default: 'service' },
  createdAt: { type: Date, required: true },
});
// Multikey index: "does any tenant allow this origin?" (CORS preflight, which has no token).
tenantSchema.index({ allowedOrigins: 1 });

const apiKeySchema = new Schema<ApiKey>({
  _id: { type: String, required: true },
  tenantId: { type: Schema.Types.ObjectId, required: true },
  secretHash: { type: String, required: true },
  label: { type: String, required: true },
  createdAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
});
apiKeySchema.index({ tenantId: 1, createdAt: 1 });

const specSchema = new Schema<Spec>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  source: {
    kind: { type: String, enum: ['upload', 'url'], required: true },
    url: { type: String, default: null },
  },
  currentVersion: { type: Number, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});
specSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const specVersionSchema = new Schema<SpecVersion>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true },
  compileKey: { type: String, required: true },
  specHash: { type: String, required: true },
  overridesHash: { type: String, required: true },
  toolCount: { type: Number, required: true },
  warningCount: { type: Number, required: true },
  diff: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true },
});
specVersionSchema.index({ tenantId: 1, specId: 1, version: 1 }, { unique: true });

const toolSettingSchema = new Schema<ToolSetting>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, required: true },
  status: { type: String, enum: ['active', 'needs_review', 'removed'], required: true },
  safety: { type: String, enum: ['read', 'write'], required: true },
  risk: { type: String, enum: ['low', 'medium', 'high'], required: true },
  updatedAt: { type: Date, required: true },
});
toolSettingSchema.index({ tenantId: 1, specId: 1, name: 1 }, { unique: true });

const connectionSchema = new Schema<ApiConnection>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  baseUrl: { type: String, required: true },
  auth: {
    kind: { type: String, enum: ['none', 'static', 'login'], required: true },
    schemes: { type: [String], default: [] },
    loginPath: { type: String, default: null },
    tokenField: { type: String, default: null },
  },
  secret: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});
connectionSchema.index({ tenantId: 1, specId: 1 }, { unique: true });

const runSchema = new Schema<Run>({
  _id: { type: String, required: true },
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  message: { type: String, required: true },
  principal: {
    userId: { type: String, required: true },
    role: { type: String, required: true },
  },
  credentialMode: { type: String, enum: ['service', 'delegated'], required: true },
  requesterSession: { type: String, default: null },
  status: {
    type: String,
    enum: ['running', 'waiting_for_approval', 'completed', 'failed', 'cancelled'],
    required: true,
  },
  approvalId: { type: Schema.Types.ObjectId, default: null },
  answer: { type: String, default: null },
  stopReason: { type: String, default: null },
  usage: { type: Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  cancelRequested: { type: Boolean, default: false },
  eventSeq: { type: Number, default: 0 },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});
runSchema.index({ tenantId: 1, createdAt: -1 });

const approvalSchema = new Schema<Approval>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  runId: { type: String, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], required: true },
  level: { type: String, enum: ['required', 'high'], required: true },
  requesterId: { type: String, required: true },
  calls: { type: Schema.Types.Mixed, required: true },
  approverId: { type: String, default: null },
  approverSession: { type: String, default: null },
  reason: { type: String, default: null },
  decidedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
});
approvalSchema.index({ tenantId: 1, status: 1, createdAt: 1 });

const auditSchema = new Schema<AuditEntry>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  at: { type: Date, required: true },
  phase: { type: String, enum: ['started', 'finished'], required: true },
  runId: { type: String, default: null },
  callId: { type: String, required: true },
  toolName: { type: String, required: true },
  safety: { type: String, enum: ['read', 'write', null], default: null },
  actor: { type: Schema.Types.Mixed, required: true },
  credentialMode: { type: String, enum: ['service', 'delegated'], required: true },
  credentialUserId: { type: String, default: null },
  argsHash: { type: String, required: true },
  status: { type: String, default: null },
  durationMs: { type: Number, default: null },
  policyVersion: { type: Number, default: null },
  approval: { type: Schema.Types.Mixed, default: null },
});
auditSchema.index({ tenantId: 1, at: -1 });
auditSchema.index({ tenantId: 1, runId: 1, at: 1 });
// The "never twice" guard (Step 4.4a): one `started` row per run, call and arguments. A retried
// run that reaches the same write again cannot insert a second one, so the write is not repeated.
auditSchema.index(
  { tenantId: 1, runId: 1, callId: 1, argsHash: 1 },
  { unique: true, partialFilterExpression: { phase: 'started', runId: { $type: 'string' } } },
);

const policyVersionSchema = new Schema<PolicyVersion>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true },
  document: { type: String, required: true },
  policyHash: { type: String, required: true },
  specVersion: { type: Number, required: true },
  createdBy: {
    kind: { type: String, enum: ['api_key'], required: true },
    keyId: { type: String, required: true },
  },
  createdAt: { type: Date, required: true },
});
// Unique: two uploads racing for the same next version cannot both win.
policyVersionSchema.index({ tenantId: 1, specId: 1, version: -1 }, { unique: true });

const runEventSchema = new Schema<RunEventRecord>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  runId: { type: String, required: true },
  seq: { type: Number, required: true },
  type: { type: String, required: true },
  data: { type: Schema.Types.Mixed, required: true },
  at: { type: Date, required: true },
});
// Unique: one event per number; also serves "events of this run after seq N, in order".
runEventSchema.index({ tenantId: 1, runId: 1, seq: 1 }, { unique: true });

const sessionSchema = new Schema<Session>({
  _id: { type: String, required: true },
  tenantId: { type: Schema.Types.ObjectId, required: true },
  specId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: String, required: true },
  role: { type: String, required: true },
  mintedBy: {
    kind: { type: String, enum: ['api_key'], required: true },
    keyId: { type: String, required: true },
  },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  userToken: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true },
});
// TTL index: MongoDB deletes a session (and its encrypted host token) once it has expired.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ tenantId: 1, userId: 1 });

/** Model names and schemas in one list, shared by the Nest modules and index creation. */
export const MODEL = {
  Tenant: { name: 'Tenant', schema: tenantSchema },
  ApiKey: { name: 'ApiKey', schema: apiKeySchema },
  Spec: { name: 'Spec', schema: specSchema },
  SpecVersion: { name: 'SpecVersion', schema: specVersionSchema },
  ToolSetting: { name: 'ToolSetting', schema: toolSettingSchema },
  ApiConnection: { name: 'ApiConnection', schema: connectionSchema },
  Run: { name: 'Run', schema: runSchema },
  Approval: { name: 'Approval', schema: approvalSchema },
  AuditEntry: { name: 'AuditEntry', schema: auditSchema },
  PolicyVersion: { name: 'PolicyVersion', schema: policyVersionSchema },
  RunEvent: { name: 'RunEvent', schema: runEventSchema },
  Session: { name: 'Session', schema: sessionSchema },
} as const;

/**
 * Builds every index (Mongoose autoIndex is off, as in the host app). Run once at startup: the
 * unique (tenantId, ...) indexes are part of correctness, not just speed.
 */
export async function createIndexes(connection: Connection): Promise<void> {
  for (const { name, schema } of Object.values(MODEL)) {
    await connection.model(name, schema).createIndexes();
  }
}
