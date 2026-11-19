/**
 * The whole pipeline with a cache in front: parse -> hash -> (cache hit) or
 * (validate -> normalize -> compile tools -> store). Validation is about 90% of the cost on a large
 * spec, so the key is computed from the parsed spec before validating.
 */
import { type CompileCache, type CompiledSpec } from './cache.js';
import { contentHash, sha256 } from './hash.js';
import type { OpenAPI } from 'openapi-types';

import { type LoadOptions, parseSpec, sourceLabel, validateSpec } from './load.js';
import { normalize } from './normalize.js';
import { compileTools } from './tools/generate.js';
import { parseOverrides } from './tools/overrides.js';

/**
 * Bump this whenever the compiler's output changes for the same input (a change in normalize,
 * naming, schema simplification, ...). It is part of every cache key, so old entries built by
 * older code are simply never looked up again. The golden snapshot diffs are the reminder.
 */
export const COMPILER_VERSION = '2.4.0';

export interface CompileSpecOptions {
  /** The overrides file's parsed JSON (validated here). Omit for none. */
  overrides?: unknown;
  cache?: CompileCache;
  load?: LoadOptions;
}

export interface CompileSpecResult extends CompiledSpec {
  /** True when the result came from the cache (no validation, no compile). */
  cached: boolean;
}

/**
 * Compiles a spec into tools, reusing a cached result when nothing that affects the output has
 * changed. The key covers three things:
 * - the spec content (canonical, so formatting and key order do not matter),
 * - the overrides (they change names, risk, merges and result fields),
 * - COMPILER_VERSION (a fix in our own code must not be hidden by an old cache entry).
 * `source` is a file path, a URL, or an already-parsed document (an upload).
 * Before -> after: `'specs/host-store.json'` -> `{ key, specHash, model, tools, cached: false }`;
 * the same call again -> the same entry with `cached: true`.
 */
export async function compileSpec(
  source: string | OpenAPI.Document,
  options: CompileSpecOptions = {},
): Promise<CompileSpecResult> {
  const doc = await parseSpec(source, options.load);
  const overrides = parseOverrides(options.overrides ?? {});
  // Hash before validating: validateSpec dereferences the document in place.
  const specHash = contentHash(doc);
  const overridesHash = contentHash(overrides);
  const key = sha256(`${COMPILER_VERSION}\n${specHash}\n${overridesHash}`);

  const hit = await options.cache?.get(key);
  if (hit !== undefined) return { ...hit, cached: true };

  const { model, warnings: normalizeWarnings } = normalize(
    await validateSpec(doc, sourceLabel(source), options.load),
  );
  const { tools, warnings: toolWarnings } = compileTools(model, overrides);
  const entry: CompiledSpec = {
    key,
    specHash,
    overridesHash,
    compilerVersion: COMPILER_VERSION,
    model,
    tools,
    normalizeWarnings,
    toolWarnings,
  };
  await options.cache?.set(key, entry);
  return { ...entry, cached: false };
}
