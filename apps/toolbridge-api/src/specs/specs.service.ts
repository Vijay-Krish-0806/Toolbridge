import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { SafeHttpClient } from '@toolbridge/agent-core';
import type { ReindexSummary, ToolIndex } from '@toolbridge/retrieval';
import {
  compileSpec,
  type CompiledSpec,
  type CompileSpecResult,
  diffModels,
  OverridesError,
  SpecLoadError,
  type ToolDefinition,
} from '@toolbridge/spec-compiler';
import { type Connection, isValidObjectId, type Model, Types } from 'mongoose';

import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { PLATFORM_CONFIG, OUTBOUND_HTTP, TOOL_INDEX } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import {
  MODEL,
  type Spec,
  type SpecVersion,
  type ToolSetting,
  type VersionDiff,
} from '../domain/models.js';
import { MongoCompiledStore } from './compiled-store.js';
import { type ReconcileSummary, reconcileTools, type ToolState } from './reconcile.js';
import { loadSpecInput, type SpecInput } from './spec-source.js';

export interface SpecView {
  id: string;
  name: string;
  source: Spec['source'];
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The tool index after a spec upload: the reindex counts, or `stale` when embedding failed (for
 * example Ollama is down). A stale index heals itself: the next upload re-embeds every tool whose
 * stored text hash does not match.
 */
export type IndexResult = ({ status: 'indexed' } & ReindexSummary) | { status: 'stale'; error: string };

/** What register and addVersion return. */
export interface VersionResult {
  spec: SpecView;
  version: SpecVersion;
  tools: ReconcileSummary;
  index: IndexResult;
}

export interface ToolView extends ToolState {
  description: string;
}

/** Everything a request for one tenant needs: its stores, built from the caller's tenant id. */
interface TenantStores {
  specs: TenantScoped<Spec>;
  versions: TenantScoped<SpecVersion>;
  tools: TenantScoped<ToolSetting>;
}

@Injectable()
export class SpecsService {
  private readonly compiled: MongoCompiledStore;
  private readonly logger = new Logger(SpecsService.name);

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(OUTBOUND_HTTP) private readonly fetchClient: SafeHttpClient,
    @Inject(TOOL_INDEX) private readonly toolIndex: ToolIndex,
    @InjectConnection() connection: Connection,
    @InjectModel(MODEL.Spec.name) private readonly specModel: Model<Spec>,
    @InjectModel(MODEL.SpecVersion.name) private readonly versionModel: Model<SpecVersion>,
    @InjectModel(MODEL.ToolSetting.name) private readonly toolModel: Model<ToolSetting>,
  ) {
    this.compiled = new MongoCompiledStore(connection);
  }

  /**
   * Registers a new spec as version 1. Read tools start enabled, write tools disabled.
   * Limits: MAX_SPECS_PER_TENANT, unique name per tenant, size (body limit / fetch limit).
   */
  async register(
    tenantId: Types.ObjectId,
    name: string,
    input: SpecInput & { overrides?: unknown },
  ): Promise<VersionResult> {
    const db = this.stores(tenantId);
    if ((await db.specs.countDocuments()) >= this.config.MAX_SPECS_PER_TENANT) {
      throw new ConflictException(
        `Spec limit reached (${String(this.config.MAX_SPECS_PER_TENANT)} per tenant).`,
      );
    }
    if (await db.specs.findOne({ name })) {
      throw new ConflictException(`A spec named "${name}" already exists.`);
    }
    const loaded = await loadSpecInput(input, this.fetchClient, this.config.SPEC_FETCH_TIMEOUT_MS);
    const result = await this.compile(loaded.document, input.overrides);

    const now = new Date();
    const spec = await this.insertSpec(db, {
      name,
      source: loaded.source,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const { states, summary } = reconcileTools(null, result.tools, null);
    const version = await this.saveVersion(db, spec._id, 1, result, null, states);
    const index = await this.reindex(tenantId, spec._id, result.tools);
    return { spec: specView(spec), version, tools: summary, index };
  }

  /**
   * Registers a new version of an existing spec: diff against the current version, then apply the
   * re-upload rules (new writes disabled, breaking writes need review, removed tools inactive).
   */
  async addVersion(
    tenantId: Types.ObjectId,
    specId: string,
    input: SpecInput & { overrides?: unknown },
  ): Promise<VersionResult> {
    const db = this.stores(tenantId);
    const spec = await this.findSpec(db, specId);
    const current = await db.versions.findOne({ specId: spec._id, version: spec.currentVersion });
    const previous = current ? await this.compiled.get(current.compileKey) : undefined;
    if (!current || !previous) throw new Error(`Spec ${specId} has no stored current version.`);

    const loaded = await loadSpecInput(input, this.fetchClient, this.config.SPEC_FETCH_TIMEOUT_MS);
    const result = await this.compile(loaded.document, input.overrides);
    const diff = diffModels(previous.model, result.model);
    const oldStates = await db.tools.find({ specId: spec._id });
    const { states, summary } = reconcileTools(oldStates, result.tools, diff);

    const versionNumber = spec.currentVersion + 1;
    const version = await this.saveVersion(
      db,
      spec._id,
      versionNumber,
      result,
      {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        breaking: diff.breaking,
      },
      states,
    );
    const updatedAt = new Date();
    await db.specs.updateOne(
      { _id: spec._id },
      { currentVersion: versionNumber, source: loaded.source, updatedAt },
    );
    const index = await this.reindex(tenantId, spec._id, result.tools);
    return {
      spec: specView({ ...spec, currentVersion: versionNumber, source: loaded.source, updatedAt }),
      version,
      tools: summary,
      index,
    };
  }

  /** The tenant's specs, newest first. */
  async list(tenantId: Types.ObjectId): Promise<SpecView[]> {
    const specs = await this.stores(tenantId).specs.find({}, { createdAt: -1 });
    return specs.map(specView);
  }

  /** One spec of the tenant with its version history (404 for anyone else's spec). */
  async get(tenantId: Types.ObjectId, specId: string): Promise<SpecView & { versions: SpecVersion[] }> {
    const db = this.stores(tenantId);
    const spec = await this.findSpec(db, specId);
    const versions = await db.versions.find({ specId: spec._id }, { version: -1 });
    return { ...specView(spec), versions };
  }

  /** The spec's tools: current definitions joined with the tenant's settings. */
  async listTools(tenantId: Types.ObjectId, specId: string): Promise<ToolView[]> {
    const db = this.stores(tenantId);
    const spec = await this.findSpec(db, specId);
    const current = await db.versions.findOne({ specId: spec._id, version: spec.currentVersion });
    const compiled = current ? await this.compiled.get(current.compileKey) : undefined;
    const descriptions = new Map((compiled?.tools ?? []).map((t) => [t.name, t.description]));
    const settings = await db.tools.find({ specId: spec._id }, { name: 1 });
    return settings.map((s) => ({
      name: s.name,
      description: descriptions.get(s.name) ?? '(no longer in the spec)',
      enabled: s.enabled,
      status: s.status,
      safety: s.safety,
      risk: s.risk,
    }));
  }

  /**
   * Enables or disables one tool. Enabling a needs_review tool marks it reviewed (active);
   * a removed tool cannot be enabled.
   */
  async setTool(
    tenantId: Types.ObjectId,
    specId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<ToolState> {
    const db = this.stores(tenantId);
    const spec = await this.findSpec(db, specId);
    const tool = await db.tools.findOne({ specId: spec._id, name: toolName });
    if (!tool) throw new NotFoundException(`No tool named "${toolName}" in this spec.`);
    if (enabled && tool.status === 'removed') {
      throw new ConflictException(`"${toolName}" is no longer in the spec and cannot be enabled.`);
    }
    const status = enabled && tool.status === 'needs_review' ? 'active' : tool.status;
    await db.tools.updateOne({ _id: tool._id }, { enabled, status, updatedAt: new Date() });
    return { name: tool.name, enabled, status, safety: tool.safety, risk: tool.risk };
  }

  /** One spec of the tenant, or 404 (same rules as every other spec route). */
  async requireSpec(tenantId: Types.ObjectId, specId: string): Promise<Spec> {
    return this.findSpec(this.stores(tenantId), specId);
  }

  /**
   * What a tool call needs: the tool's definition in the current version, the spec's security
   * schemes, and the tenant's setting for that tool (null when the tool is unknown).
   */
  async toolForCall(
    tenantId: Types.ObjectId,
    spec: Spec,
    toolName: string,
  ): Promise<{ compiled: CompiledSpec; setting: ToolSetting | null }> {
    const compiled = await this.currentCompiled(tenantId, spec);
    const setting = await this.stores(tenantId).tools.findOne({ specId: spec._id, name: toolName });
    return { compiled, setting };
  }

  /** The compiled current version of a spec (tools, model, security schemes). */
  async currentCompiled(tenantId: Types.ObjectId, spec: Spec): Promise<CompiledSpec> {
    const current = await this.stores(tenantId).versions.findOne({
      specId: spec._id,
      version: spec.currentVersion,
    });
    const compiled = current ? await this.compiled.get(current.compileKey) : undefined;
    if (!compiled) throw new Error(`Spec ${spec._id.toHexString()} has no stored current version.`);
    return compiled;
  }

  /**
   * Step 3.1: updates the spec's vectors in the tool index, synchronously for now (a worker takes
   * this off the request path in Phase 4). Runs after the version is saved, and a failure does not
   * undo the upload: the version is the source of truth and the index can always be rebuilt from it.
   */
  private async reindex(
    tenantId: Types.ObjectId,
    specId: Types.ObjectId,
    tools: ToolDefinition[],
  ): Promise<IndexResult> {
    const scope = { tenantId: tenantId.toHexString(), specId: specId.toHexString() };
    try {
      return { status: 'indexed', ...(await this.toolIndex.reindex(scope, tools)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Tool index is stale for spec ${scope.specId}: ${message}`);
      return { status: 'stale', error: 'Embedding failed; the tool index will be rebuilt on the next upload.' };
    }
  }

  /** Builds this request's tenant-scoped stores. Every tenant-data access goes through them. */
  private stores(tenantId: Types.ObjectId): TenantStores {
    return {
      specs: new TenantScoped(mongooseCollection(this.specModel), tenantId),
      versions: new TenantScoped(mongooseCollection(this.versionModel), tenantId),
      tools: new TenantScoped(mongooseCollection(this.toolModel), tenantId),
    };
  }

  /**
   * Finds a spec of this tenant. A malformed id, an unknown id and another tenant's id all give the
   * same 404, so the response never confirms that someone else's spec exists.
   */
  private async findSpec(db: TenantStores, specId: string): Promise<Spec> {
    const spec = isValidObjectId(specId)
      ? await db.specs.findOne({ _id: new Types.ObjectId(specId) })
      : null;
    if (!spec) throw new NotFoundException('Spec not found.');
    return spec;
  }

  /** Compiles through the shared content-addressed store; spec and overrides errors become 422. */
  private async compile(document: Record<string, unknown>, overrides: unknown): Promise<CompileSpecResult> {
    try {
      return await compileSpec(document as Parameters<typeof compileSpec>[0], {
        overrides: overrides ?? {},
        cache: this.compiled,
      });
    } catch (error) {
      if (error instanceof SpecLoadError || error instanceof OverridesError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  /** Inserts the spec; a concurrent duplicate name hits the unique index and becomes 409. */
  private async insertSpec(db: TenantStores, doc: Omit<Spec, '_id' | 'tenantId'>): Promise<Spec> {
    try {
      return await db.specs.insertOne(doc);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 11000) {
        throw new ConflictException(`A spec named "${doc.name}" already exists.`);
      }
      throw error;
    }
  }

  /** Records a version and writes every tool's state (insert new tools, update existing ones). */
  private async saveVersion(
    db: TenantStores,
    specId: Types.ObjectId,
    version: number,
    result: CompileSpecResult,
    diff: VersionDiff | null,
    states: ToolState[],
  ): Promise<SpecVersion> {
    const saved = await db.versions.insertOne({
      specId,
      version,
      compileKey: result.key,
      specHash: result.specHash,
      overridesHash: result.overridesHash,
      toolCount: result.tools.length,
      warningCount: result.normalizeWarnings.length + result.toolWarnings.length,
      diff,
      createdAt: new Date(),
    });
    const now = new Date();
    for (const state of states) {
      const matched = await db.tools.updateOne(
        { specId, name: state.name },
        { enabled: state.enabled, status: state.status, safety: state.safety, risk: state.risk, updatedAt: now },
      );
      if (matched === 0) await db.tools.insertOne({ specId, ...state, updatedAt: now });
    }
    return saved;
  }
}

/** The public shape of a spec. */
function specView(spec: Spec): SpecView {
  return {
    id: spec._id.toHexString(),
    name: spec.name,
    source: spec.source,
    currentVersion: spec.currentVersion,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  };
}

