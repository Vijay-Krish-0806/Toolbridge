/**
 * Decides each tool's enabled flag and status when a spec version is registered. Pure, so the
 * rules are easy to read and test. Rules (secure by default):
 * 1. A new read tool starts enabled; a new write tool starts disabled.
 * 2. An existing tool keeps its setting, except a write tool whose operation changed in a breaking
 *    way (Step 2.4 diff): it becomes disabled and needs_review until someone enables it again.
 *    A tool that turned from read into write counts as a new write tool.
 * 3. A tool that is no longer in the spec becomes removed: disabled, and it cannot be enabled.
 */
import type { SpecDiff, ToolDefinition } from '@toolbridge/spec-compiler';

import type { ToolStatus } from '../domain/models.js';

export interface ToolState {
  name: string;
  enabled: boolean;
  status: ToolStatus;
  safety: ToolDefinition['safety'];
  risk: ToolDefinition['risk'];
}

export interface ReconcileSummary {
  newTools: number;
  /** New write tools, left disabled. */
  newWritesDisabled: number;
  /** Write tools disabled because their operation changed in a breaking way. */
  needsReview: string[];
  removed: string[];
}

/** HTTP identity of an operation, as the diff matches them: `GET /orders/{}`. */
function identity(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`;
}

/**
 * Computes the new tool states.
 * Before -> after (re-upload): `orders_cancel` enabled, its operation now has a new required
 * field (breaking) -> `{ name: 'orders_cancel', enabled: false, status: 'needs_review' }`.
 */
export function reconcileTools(
  previous: ToolState[] | null,
  next: ToolDefinition[],
  diff: SpecDiff | null,
): { states: ToolState[]; summary: ReconcileSummary } {
  const before = new Map((previous ?? []).map((s) => [s.name, s]));
  const breakingOps = new Set(
    (diff?.changed ?? []).filter((c) => c.breaking).map((c) => identity(c.method, c.path)),
  );
  const summary: ReconcileSummary = { newTools: 0, newWritesDisabled: 0, needsReview: [], removed: [] };

  const states: ToolState[] = next.map((tool) => {
    const old = before.get(tool.name);
    const base = { name: tool.name, safety: tool.safety, risk: tool.risk };
    const isNewWrite = tool.safety === 'write' && (old === undefined || old.safety === 'read');
    if (old === undefined || old.status === 'removed' || isNewWrite) {
      if (old === undefined) summary.newTools++;
      if (tool.safety === 'write') summary.newWritesDisabled++;
      return { ...base, enabled: tool.safety === 'read', status: 'active' };
    }
    const changedBreaking = tool.variants.some((v) => breakingOps.has(identity(v.method, v.path)));
    if (tool.safety === 'write' && changedBreaking) {
      summary.needsReview.push(tool.name);
      return { ...base, enabled: false, status: 'needs_review' };
    }
    return { ...base, enabled: old.enabled, status: old.status };
  });

  const stillThere = new Set(next.map((t) => t.name));
  for (const old of previous ?? []) {
    if (stillThere.has(old.name)) continue;
    if (old.status !== 'removed') summary.removed.push(old.name);
    states.push({ ...old, enabled: false, status: 'removed' });
  }
  return { states, summary };
}
