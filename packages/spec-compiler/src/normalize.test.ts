/**
 * Step 2.1 acceptance checks.
 * - Snapshot: the host spec's IR is written to a reviewable JSON file, so any change in how the
 *   compiler reads specs shows up as a diff.
 * - Security: a `$ref` to a local file must never be read (Local File Inclusion guard). Kept as a
 *   test because a parser upgrade could silently change this behavior.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSpec } from './load.js';
import { normalize } from './normalize.js';

const HOST_SPEC = resolve(import.meta.dirname, '../../../specs/host-store.json');

describe('normalize', () => {
  it('compiles the host spec into a stable IR', async () => {
    const { model, warnings } = normalize(await loadSpec(HOST_SPEC));

    expect(warnings).toEqual([]);
    expect(model.operations).toHaveLength(41);
    await expect(JSON.stringify(model, null, 2)).toMatchFileSnapshot(
      './__snapshots__/host-store.ir.json',
    );
  });

  it('never reads a local file through $ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec-lfi-'));
    try {
      await writeFile(join(dir, 'secret.json'), JSON.stringify({ secret: 'TOP-SECRET' }));
      await writeFile(
        join(dir, 'evil.json'),
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'evil', version: '1' },
          paths: {
            '/x': {
              get: {
                operationId: 'leak',
                responses: {
                  '200': {
                    description: 'ok',
                    content: { 'application/json': { schema: { $ref: './secret.json' } } },
                  },
                },
              },
            },
          },
        }),
      );

      const { model, warnings } = normalize(await loadSpec(join(dir, 'evil.json')));

      expect(JSON.stringify(model)).not.toContain('TOP-SECRET');
      expect(warnings).toContainEqual({
        operation: 'leak',
        message:
          'External $ref "./secret.json" was not loaded (external refs are disabled for safety).',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
