/**
 * Loading the labelled tool datasets (evals/retrieval/*.json) and the specs they are about.
 * Shared by the Step 3.2 recall baseline and the Step 3.4 experiments, so both score the same
 * questions against the same tools.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileSpec, type ToolDefinition } from '@toolbridge/spec-compiler';
import { z } from 'zod';

export const root = resolve(import.meta.dirname, '../../../..');

/** Where each dataset's spec comes from, and the core set the policy always adds. */
export const SPECS: Record<string, { spec: string; overrides?: string; core: string[] }> = {
  'host-store': {
    spec: 'specs/host-store.json',
    overrides: 'specs/host-store.overrides.json',
    core: ['orders_get'],
  },
  github: { spec: '.cache/public-specs/api.github.com.2026-03-10.json', core: [] },
};

export const TOOL_DATASETS = ['evals/retrieval/host-store.json', 'evals/retrieval/github.json'];

const dataset = z.object({
  spec: z.string(),
  queries: z.array(
    z.object({
      id: z.string(),
      q: z.string(),
      expect: z.array(z.array(z.string()).min(1)).min(1),
      tags: z.array(z.string()),
    }),
  ),
  offTopic: z.array(z.string()),
});
export type Query = z.infer<typeof dataset>['queries'][number];

/**
 * Reads one dataset, compiles its spec, and checks the labels against the spec's tools.
 * Before -> after: `'evals/retrieval/host-store.json'` -> `{ data: 43 queries, tools: 35, ... }`.
 */
export async function loadToolDataset(file: string): Promise<{
  raw: string;
  data: z.infer<typeof dataset>;
  core: string[];
  tools: ToolDefinition[];
  specHash: string;
  labelNotes: string[];
}> {
  const raw = await readFile(resolve(root, file), 'utf8');
  const data = dataset.parse(JSON.parse(raw));
  const source = SPECS[data.spec];
  if (!source) throw new Error(`Unknown spec "${data.spec}" in ${file}.`);
  const overrides: unknown = source.overrides
    ? JSON.parse(await readFile(resolve(root, source.overrides), 'utf8'))
    : {};
  const { tools, specHash } = await compileSpec(resolve(root, source.spec), { overrides });
  const labelNotes = checkLabels(data.queries, new Set(tools.map((t) => t.name)));
  return { raw, data, core: source.core, tools, specHash, labelNotes };
}

/** Drops expected names that are not tools of this spec; a group with none left is an error. */
function checkLabels(queries: Query[], names: Set<string>): string[] {
  const notes: string[] = [];
  for (const query of queries) {
    query.expect = query.expect.map((group) => {
      const known = group.filter((name) => names.has(name));
      const unknown = group.filter((name) => !names.has(name));
      if (unknown.length) notes.push(`${query.id}: not a tool, ignored: ${unknown.join(', ')}`);
      if (!known.length) throw new Error(`${query.id}: no expected tool exists in this spec.`);
      return known;
    });
  }
  return notes;
}
