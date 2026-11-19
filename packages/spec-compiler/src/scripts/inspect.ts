/**
 * Steps 2.1 and 2.2 acceptance check: loads a spec from a file or URL, normalizes it, and prints
 * a summary. Run with
 * `pnpm --filter @toolbridge/spec-compiler inspect <file-or-url> [--ops] [--tools] [--overrides f] [--json out.json]`.
 *   --ops        also prints one line per operation
 *   --tools      also compiles tools and prints a summary (and one line per tool, up to 100)
 *   --overrides  an overrides JSON file; implies --tools
 *   --json       writes the ApiModel (or, with --tools, the tools) to a file, to read or diff it
 *   --cache dir  compiles through the content-addressed cache in `dir` (Step 2.4) and reports
 *                whether it was a hit; use with --overrides to include them in the key
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FileCache } from '../cache.js';
import { compileSpec } from '../compile.js';
import { loadSpec } from '../load.js';
import type { ApiModel } from '../model.js';
import { normalize } from '../normalize.js';
import { compileTools } from '../tools/generate.js';
import { TOOL_NAME_PATTERN } from '../tools/naming.js';
import { parseOverrides } from '../tools/overrides.js';
import type { ToolDefinition } from '../tools/types.js';

interface Args {
  source: string;
  showOps: boolean;
  showTools: boolean;
  overridesFile?: string;
  jsonOut?: string;
  cacheDir?: string;
}

/**
 * Reads the command line. A relative file path is resolved against the directory `pnpm` was run
 * from (INIT_CWD), not the package folder, so `specs/host-store.json` works from the repo root.
 */
function parseArgs(argv: string[]): Args {
  const [source, ...flags] = argv;
  if (source === undefined) {
    console.error(
      'Usage: inspect <file-or-url> [--ops] [--tools] [--overrides file] [--json out.json]',
    );
    process.exit(2);
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  /** The value after a flag, as an absolute path, or undefined if the flag is absent. */
  const pathAfter = (flag: string): string | undefined => {
    const index = flags.indexOf(flag);
    const value = index === -1 ? undefined : flags[index + 1];
    return value === undefined ? undefined : resolve(base, value);
  };
  const jsonOut = pathAfter('--json');
  const overridesFile = pathAfter('--overrides');
  const cacheDir = pathAfter('--cache');
  return {
    source: /^https?:\/\//i.test(source) ? source : resolve(base, source),
    showOps: flags.includes('--ops'),
    showTools: flags.includes('--tools') || overridesFile !== undefined,
    ...(overridesFile !== undefined && { overridesFile }),
    ...(jsonOut !== undefined && { jsonOut }),
    ...(cacheDir !== undefined && { cacheDir }),
  };
}

/** Loads, normalizes and prints counts, timings, memory and warnings; then tools if asked. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cacheDir !== undefined) {
    await printCached(args.source, args.cacheDir, args.overridesFile);
    return;
  }

  const t0 = performance.now();
  const doc = await loadSpec(args.source);
  const t1 = performance.now();
  const { model, warnings } = normalize(doc);
  const t2 = performance.now();
  const json = JSON.stringify(model);

  const byMethod = new Map<string, number>();
  for (const op of model.operations) byMethod.set(op.method, (byMethod.get(op.method) ?? 0) + 1);
  const methods = [...byMethod].map(([m, n]) => `${m}=${String(n)}`).join(' ');
  const publicOps = model.operations.filter((o) => o.security.length === 0).length;

  console.log(`${model.title} ${model.version} (OpenAPI ${model.openapiVersion})`);
  console.log(`  operations:       ${String(model.operations.length)}  ${methods}`);
  console.log(
    `  tags:             ${String(new Set(model.operations.flatMap((o) => o.tags)).size)}`,
  );
  console.log(`  security schemes: ${Object.keys(model.securitySchemes).join(', ') || '(none)'}`);
  console.log(`  public ops:       ${String(publicOps)}`);
  console.log(`  cyclic schemas:   ${String(Object.keys(model.schemas).length)}`);
  console.log(`  IR size:          ${(json.length / 1024).toFixed(0)} KiB as JSON`);
  console.log(
    `  load+validate:    ${(t1 - t0).toFixed(0)} ms, normalize: ${(t2 - t1).toFixed(0)} ms`,
  );
  console.log(
    `  heap used:        ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MiB`,
  );
  printWarnings(warnings.map((w) => ({ subject: w.operation, message: w.message })));

  if (args.showOps) {
    for (const op of model.operations) {
      const body = op.requestBody ? ` body=${op.requestBody.contentType}` : '';
      const params = String(op.parameters.length);
      console.log(
        `  ${op.method.toUpperCase().padEnd(6)} ${op.path}  ${op.id}  params=${params}${body}`,
      );
    }
  }

  const tools = args.showTools ? await printTools(model, args.overridesFile) : undefined;
  if (args.jsonOut !== undefined) {
    await writeFile(args.jsonOut, JSON.stringify(tools ?? model, null, 2));
    console.log(`  wrote ${args.jsonOut}`);
  }
}

/**
 * Compiles tools and prints a summary: counts by safety and risk, invalid or duplicate names, the
 * size of the whole tool menu as the model would receive it, warnings, and one line per tool.
 */
async function printTools(
  model: ApiModel,
  overridesFile: string | undefined,
): Promise<ToolDefinition[]> {
  const raw: unknown =
    overridesFile === undefined ? {} : JSON.parse(await readFile(overridesFile, 'utf8'));
  const t0 = performance.now();
  const { tools, warnings } = compileTools(model, parseOverrides(raw));
  const ms = performance.now() - t0;

  // The menu as an OpenAI-compatible request sends it.
  const menu = JSON.stringify(
    tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  );
  const sizes = tools.map((t) => JSON.stringify(t.inputSchema).length).sort((a, b) => a - b);
  /** Counts tools matching a condition, as a string for printing. */
  const count = (pred: (t: ToolDefinition) => boolean): string => String(tools.filter(pred).length);
  const duplicates = tools.length - new Set(tools.map((t) => t.name)).size;
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;

  console.log(`\nTools${overridesFile === undefined ? '' : ` (overrides: ${overridesFile})`}`);
  console.log(`  tools:            ${String(tools.length)} (compiled in ${ms.toFixed(0)} ms)`);
  console.log(
    `  safety:           read=${count((t) => t.safety === 'read')} write=${count((t) => t.safety === 'write')}`,
  );
  console.log(
    `  risk:             low=${count((t) => t.risk === 'low')} medium=${count((t) => t.risk === 'medium')} high=${count((t) => t.risk === 'high')}`,
  );
  console.log(`  merged tools:     ${count((t) => t.variants.length > 1)}`);
  console.log(
    `  invalid names:    ${count((t) => !TOOL_NAME_PATTERN.test(t.name))}, duplicates: ${String(duplicates)}`,
  );
  console.log(
    `  tool menu:        ${(menu.length / 1024).toFixed(1)} KiB (~${String(Math.round(menu.length / 4))} tokens, rough chars/4 estimate)`,
  );
  console.log(`  schema chars:     median ${String(median)}, max ${String(sizes.at(-1) ?? 0)}`);
  printWarnings(warnings);

  if (tools.length <= 100) {
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      const required = new Set((t.inputSchema.required ?? []) as string[]);
      const argList = props.map((p) => (required.has(p) ? `${p}*` : p)).join(', ');
      const merged = t.variants.length > 1 ? ` [${String(t.variants.length)} variants]` : '';
      console.log(
        `  ${t.name.padEnd(34)} ${t.safety.padEnd(5)} ${t.risk.padEnd(6)} (${argList})${merged}`,
      );
    }
  }
  return tools;
}

/**
 * Compiles through the file cache and reports hit or miss, the hashes that make up the key, and
 * the time taken. Run it twice: the second run should be a hit and much faster.
 */
async function printCached(
  source: string,
  cacheDir: string,
  overridesFile: string | undefined,
): Promise<void> {
  const overrides: unknown =
    overridesFile === undefined ? undefined : JSON.parse(await readFile(overridesFile, 'utf8'));
  const t0 = performance.now();
  const result = await compileSpec(source, {
    cache: new FileCache(cacheDir),
    ...(overrides !== undefined && { overrides }),
  });
  const ms = performance.now() - t0;
  console.log(
    `${result.model.title} ${result.model.version}: ${result.cached ? 'CACHE HIT' : 'cache miss, compiled and stored'} in ${ms.toFixed(0)} ms`,
  );
  console.log(`  spec hash:      ${result.specHash.slice(0, 16)}...`);
  console.log(`  overrides hash: ${result.overridesHash.slice(0, 16)}...`);
  console.log(`  compiler:       ${result.compilerVersion}`);
  console.log(`  cache key:      ${result.key.slice(0, 16)}... (${cacheDir})`);
  console.log(`  tools:          ${String(result.tools.length)}`);
}

/** Prints the warning count and the first ten warnings. */
function printWarnings(warnings: { subject?: string | undefined; message: string }[]): void {
  console.log(`  warnings:         ${String(warnings.length)}`);
  for (const w of warnings.slice(0, 10)) {
    console.log(`    - ${w.subject ? `[${w.subject}] ` : ''}${w.message}`);
  }
  if (warnings.length > 10) console.log(`    ... and ${String(warnings.length - 10)} more`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
