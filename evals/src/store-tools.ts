/**
 * The host store's tools and role policy, compiled from specs/. The dataset's labels are checked
 * against these, so a renamed tool or a changed policy breaks the check instead of the evals.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parsePolicy, type Policy } from '@toolbridge/policy';
import {
  type ApiModel,
  compileTools,
  loadSpec,
  normalize,
  parseOverrides,
  type ToolDefinition,
} from '@toolbridge/spec-compiler';

import { root } from './dataset.js';

export interface StoreTools {
  model: ApiModel;
  tools: ToolDefinition[];
  policy: Policy;
}

/** Compiles specs/host-store.json with its overrides and reads its policy file. */
export async function loadStoreTools(): Promise<StoreTools> {
  const specs = resolve(root, 'specs');
  /** One JSON file of specs/, not validated yet. */
  const json = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(resolve(specs, name), 'utf8')) as unknown;
  const { model } = normalize(await loadSpec(resolve(specs, 'host-store.json')));
  const { tools } = compileTools(model, parseOverrides(await json('host-store.overrides.json')));
  return { model, tools, policy: parsePolicy(await json('host-store.policy.json')) };
}
