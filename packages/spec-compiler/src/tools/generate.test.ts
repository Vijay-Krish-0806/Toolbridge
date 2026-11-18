/**
 * Step 2.2 acceptance check: the host spec plus its overrides file compiles into a golden
 * snapshot of tools. Any change to naming, schemas, descriptions or risk shows up as a diff.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSpec } from '../load.js';
import { normalize } from '../normalize.js';
import { compileTools } from './generate.js';
import { TOOL_NAME_PATTERN } from './naming.js';
import { parseOverrides } from './overrides.js';

const SPECS = resolve(import.meta.dirname, '../../../../specs');

describe('compileTools', () => {
  it('compiles the host spec into a golden set of tools', async () => {
    const { model } = normalize(await loadSpec(resolve(SPECS, 'host-store.json')));
    const overrides = parseOverrides(
      JSON.parse(await readFile(resolve(SPECS, 'host-store.overrides.json'), 'utf8')),
    );

    const { tools, warnings } = compileTools(model, overrides);

    expect(warnings).toEqual([]);
    expect(tools).toHaveLength(35);
    expect(tools.every((t) => TOOL_NAME_PATTERN.test(t.name))).toBe(true);
    await expect(JSON.stringify(tools, null, 2)).toMatchFileSnapshot(
      '../__snapshots__/host-store.tools.json',
    );
  });
});
