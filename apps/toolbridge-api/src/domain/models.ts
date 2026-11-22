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
 * running: the graph is executing in this process. waiting_for_approval: paused on an approval
 * card (its checkpoint is in MongoDB). completed: the graph finished. failed: it threw, or the
 * process stopped while it was running.
 */
export type RunStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed';

/**
 * Whose credential the tool calls use (ADR 0027, 0028). Only `service` (the spec's stored
 * connection) exists until Step 4.4c adds user delegation; it is recorded so the audit trail of
 * every run says which one it used.
 */
export type CredentialMode = 'service';

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
  status: RunStatus;
  /** The open (or last) approval of this run. */
  approvalId: Types.ObjectId | null;
  answer: string | null;
  stopReason: string | null;
  usage: AgentUsage | null;
  /** Why the run failed, for people; never a stack trace. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * One approval card: a paused model turn with every call and its exact arguments. Created by the
 * API when it sees the pause (outside the graph, so the graph's approval node stays side-effect
 * free). Decided exactly once: the pending -> decided change is one atomic update.
 */
export interface Approval {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  runId: string;
  status: ApprovalStatus;
  /** The strictest level in the turn; `high` means the requester may not approve it. */
  level: ApprovalRequest['level'];
  requesterId: string;
  calls: PendingCall[];
  approverId: string | null;
  reason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

const tenantSchema = new Schema<Tenant>({
  name: { type: String, required: true },
  createdAt: { type: Date, required: true },
});

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
  credentialMode: { type: String, enum: ['service'], required: true },
  status: {
    type: String,
    enum: ['running', 'waiting_for_approval', 'completed', 'failed'],
    required: true,
  },
  approvalId: { type: Schema.Types.ObjectId, default: null },
  answer: { type: String, default: null },
  stopReason: { type: String, default: null },
  usage: { type: Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});
runSchema.index({ tenantId: 1, createdAt: -1 });

const approvalSchema = new Schema<Approval>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  runId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
  level: { type: String, enum: ['required', 'high'], required: true },
  requesterId: { type: String, required: true },
  calls: { type: Schema.Types.Mixed, required: true },
  approverId: { type: String, default: null },
  reason: { type: String, default: null },
  decidedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
});
approvalSchema.index({ tenantId: 1, status: 1, createdAt: 1 });

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
