/**
 * Step 2.1 acceptance check: loads a spec from a file or URL, normalizes it, and prints a summary.
 * Run with `pnpm --filter @toolbridge/spec-compiler inspect <file-or-url> [--ops] [--json out.json]`.
 *   --ops   also prints one line per operation
 *   --json  writes the full ApiModel to a file, to read or diff it
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadSpec } from '../load.js';
import { normalize } from '../normalize.js';

/**
 * Reads the command line. A relative file path is resolved against the directory `pnpm` was run
 * from (INIT_CWD), not the package folder, so `specs/host-store.json` works from the repo root.
 */
function parseArgs(argv: string[]): { source: string; showOps: boolean; jsonOut?: string } {
  const [source, ...flags] = argv;
  if (source === undefined) {
    console.error('Usage: inspect <file-or-url> [--ops] [--json out.json]');
    process.exit(2);
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  const isUrl = /^https?:\/\//i.test(source);
  const jsonIndex = flags.indexOf('--json');
  const jsonOut = jsonIndex === -1 ? undefined : flags[jsonIndex + 1];
  return {
    source: isUrl ? source : resolve(base, source),
    showOps: flags.includes('--ops'),
    ...(jsonOut !== undefined && { jsonOut: resolve(base, jsonOut) }),
  };
}

/** Loads, normalizes and prints counts, timings, memory and warnings. */
async function main(): Promise<void> {
  const { source, showOps, jsonOut } = parseArgs(process.argv.slice(2));

  const t0 = performance.now();
  const doc = await loadSpec(source);
  const t1 = performance.now();
  const { model, warnings } = normalize(doc);
  const t2 = performance.now();
  const json = JSON.stringify(model);

  const byMethod = new Map<string, number>();
  for (const op of model.operations) byMethod.set(op.method, (byMethod.get(op.method) ?? 0) + 1);

  console.log(`${model.title} ${model.version} (OpenAPI ${model.openapiVersion})`);
  console.log(
    `  operations:       ${String(model.operations.length)}  ${[...byMethod].map(([m, n]) => `${m}=${String(n)}`).join(' ')}`,
  );
  console.log(
    `  tags:             ${String(new Set(model.operations.flatMap((o) => o.tags)).size)}`,
  );
  console.log(`  security schemes: ${Object.keys(model.securitySchemes).join(', ') || '(none)'}`);
  console.log(
    `  public ops:       ${String(model.operations.filter((o) => o.security.length === 0).length)}`,
  );
  console.log(`  cyclic schemas:   ${String(Object.keys(model.schemas).length)}`);
  console.log(`  IR size:          ${(json.length / 1024).toFixed(0)} KiB as JSON`);
  console.log(
    `  load+validate:    ${(t1 - t0).toFixed(0)} ms, normalize: ${(t2 - t1).toFixed(0)} ms`,
  );
  console.log(
    `  heap used:        ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MiB`,
  );
  console.log(`  warnings:         ${String(warnings.length)}`);
  for (const w of warnings.slice(0, 10))
    console.log(`    - ${w.operation ? `[${w.operation}] ` : ''}${w.message}`);
  if (warnings.length > 10) console.log(`    ... and ${String(warnings.length - 10)} more`);

  if (showOps) {
    for (const op of model.operations) {
      const body = op.requestBody ? ` body=${op.requestBody.contentType}` : '';
      console.log(
        `  ${op.method.toUpperCase().padEnd(6)} ${op.path}  ${op.id}  params=${String(op.parameters.length)}${body}`,
      );
    }
  }
  if (jsonOut !== undefined) {
    await writeFile(jsonOut, JSON.stringify(model, null, 2));
    console.log(`  wrote ${jsonOut}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
