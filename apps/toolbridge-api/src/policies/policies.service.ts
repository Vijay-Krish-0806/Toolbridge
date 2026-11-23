import { createHash } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MEMORY_SAVE_TOOL } from '@toolbridge/agent-core';
import { matches, parsePolicy, type Policy } from '@toolbridge/policy';
import type { Model, Types } from 'mongoose';

import { mongooseCollection } from '../common/mongoose-collection.js';
import { TenantScoped } from '../common/tenant-scoped.js';
import { MODEL, type PolicyVersion, type Spec } from '../domain/models.js';
import { SpecsService } from '../specs/specs.service.js';

/**
 * The policy a spec gets when nobody uploaded one: no roles, so every role is denied every tool
 * (deny by default), and every write needs approval should a policy ever allow one.
 */
export const DENY_ALL: Policy = parsePolicy({ version: 1, roles: {} });

/** Metadata of one version (the history list shows no policy bodies). */
export interface PolicyVersionView {
  version: number;
  policyHash: string;
  specVersion: number;
  createdBy: PolicyVersion['createdBy'];
  createdAt: Date;
}

/** The current policy, with how it relates to the spec's current version. */
export interface PolicyView extends PolicyVersionView {
  policy: Policy;
  currentSpecVersion: number;
  /** True when the spec has a newer version than the one this policy was checked against. */
  stale: boolean;
}

/**
 * Role policies stored per spec (Step 4.3b, ADR 0033). Each upload is validated with
 * `parsePolicy`, checked against the spec's current tools, and inserted as a NEW version; nothing
 * is updated or deleted. Runs load the highest version; with none, they get DENY_ALL: deny by
 * default is a storage rule here (no row = no access), not only a code rule.
 */
@Injectable()
export class PoliciesService {
  constructor(
    @InjectModel(MODEL.PolicyVersion.name) private readonly model: Model<PolicyVersion>,
    private readonly specs: SpecsService,
  ) {}

  /**
   * Uploads a policy as the spec's next version.
   * Before -> after: (spec at version 2, policy with "refunds_reqest" misspelled) ->
   * `{ version: 1, specVersion: 2, policyHash: '…', warnings: ['roles.support.allow: no tool named "refunds_reqest" in spec version 2.'] }`.
   * Invalid policy -> 422 with the validation message. Two uploads racing -> one gets 409.
   */
  async set(
    tenantId: Types.ObjectId,
    keyId: string,
    specId: string,
    raw: unknown,
  ): Promise<PolicyVersionView & { warnings: string[] }> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    let policy: Policy;
    try {
      policy = parsePolicy(raw);
    } catch (error) {
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : 'Invalid policy.',
      );
    }
    const compiled = await this.specs.currentCompiled(tenantId, spec);
    const warnings = coverageWarnings(
      policy,
      [...compiled.tools.map((t) => t.name), MEMORY_SAVE_TOOL], // ours, so not in the spec
      spec.currentVersion,
    );

    const latest = await this.latest(tenantId, spec._id);
    const document = JSON.stringify(policy);
    let saved: PolicyVersion;
    try {
      saved = await this.scoped(tenantId).insertOne({
        specId: spec._id,
        version: (latest?.version ?? 0) + 1,
        document,
        policyHash: createHash('sha256').update(document, 'utf8').digest('hex'),
        specVersion: spec.currentVersion,
        createdBy: { kind: 'api_key', keyId },
        createdAt: new Date(),
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 11000) {
        throw new ConflictException('The policy was changed by another request; try again.');
      }
      throw error;
    }
    return { ...versionView(saved), warnings };
  }

  /** The current policy, or 404 that says what having none means. */
  async current(tenantId: Types.ObjectId, specId: string): Promise<PolicyView> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    const latest = await this.latest(tenantId, spec._id);
    if (!latest) {
      throw new NotFoundException(
        'This spec has no policy, so every tool is denied for every role.',
      );
    }
    return {
      ...versionView(latest),
      policy: parsePolicy(JSON.parse(latest.document)),
      currentSpecVersion: spec.currentVersion,
      stale: latest.specVersion < spec.currentVersion,
    };
  }

  /** Every version of the spec's policy, newest first (metadata only). */
  async versions(tenantId: Types.ObjectId, specId: string): Promise<PolicyVersionView[]> {
    const spec = await this.specs.requireSpec(tenantId, specId);
    const rows = await this.scoped(tenantId).find({ specId: spec._id }, { version: -1 });
    return rows.map(versionView);
  }

  /**
   * The policy a run uses, loaded for every leg (start and resume), so a change applies to the
   * next leg. No stored version -> DENY_ALL with `version: null`.
   * The stored text is parsed again: what was valid when saved must still be valid now.
   */
  async forRun(
    tenantId: Types.ObjectId,
    spec: Spec,
  ): Promise<{ policy: Policy; version: number | null }> {
    const latest = await this.latest(tenantId, spec._id);
    if (!latest) return { policy: DENY_ALL, version: null };
    return { policy: parsePolicy(JSON.parse(latest.document)), version: latest.version };
  }

  private async latest(
    tenantId: Types.ObjectId,
    specId: Types.ObjectId,
  ): Promise<PolicyVersion | undefined> {
    const [row] = await this.scoped(tenantId).find({ specId }, { version: -1 }, 1);
    return row;
  }

  private scoped(tenantId: Types.ObjectId): TenantScoped<PolicyVersion> {
    return new TenantScoped(mongooseCollection(this.model), tenantId);
  }
}

/**
 * Patterns that do not fit the spec: an exact name the spec does not have (usually a typo), or a
 * `*` pattern that matches no tool. Warnings, not errors: the policy is still valid and safe
 * (an unknown name allows nothing), but it probably does not do what its author meant.
 */
export function coverageWarnings(policy: Policy, tools: string[], specVersion: number): string[] {
  const where: [string, string[]][] = [
    ...Object.entries(policy.roles).flatMap(([role, rules]): [string, string[]][] => [
      [`roles.${role}.allow`, rules.allow],
      [`roles.${role}.deny`, rules.deny],
    ]),
    ...policy.approvals.rules.map((rule, i): [string, string[]] => [
      `approvals.rules[${String(i)}].tools`,
      rule.tools,
    ]),
  ];
  const warnings: string[] = [];
  for (const [path, patterns] of where) {
    for (const p of patterns) {
      if (tools.some((name) => matches(p, name))) continue;
      warnings.push(
        p.includes('*')
          ? `${path}: "${p}" matches no tool in spec version ${String(specVersion)}.`
          : `${path}: no tool named "${p}" in spec version ${String(specVersion)}.`,
      );
    }
  }
  return warnings;
}

function versionView(row: PolicyVersion): PolicyVersionView {
  return {
    version: row.version,
    policyHash: row.policyHash,
    specVersion: row.specVersion,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
