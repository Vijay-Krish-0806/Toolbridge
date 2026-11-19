/**
 * Platform data. Pool model (ADR 0019): one database, and every tenant-owned document carries
 * `tenantId`, with every index starting with it, so each tenant's queries stay on its own slice.
 */
import { type Connection, Schema, type Types } from 'mongoose';

import type { RiskLevel, SafetyClass } from '@toolbridge/spec-compiler';

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

/** Model names and schemas in one list, shared by the Nest modules and index creation. */
export const MODEL = {
  Tenant: { name: 'Tenant', schema: tenantSchema },
  ApiKey: { name: 'ApiKey', schema: apiKeySchema },
  Spec: { name: 'Spec', schema: specSchema },
  SpecVersion: { name: 'SpecVersion', schema: specVersionSchema },
  ToolSetting: { name: 'ToolSetting', schema: toolSettingSchema },
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
