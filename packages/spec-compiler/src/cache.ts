/**
 * Where compiled specs are kept. A port with small adapters (like LLMProvider and AuthProvider):
 * MemoryCache for one process, FileCache for local runs, and a database adapter in Step 2.6.
 *
 * Content-addressed: the key is a hash of everything that decides the output (compile.ts), so an
 * entry can never be stale and nothing ever needs invalidating. Changed content means a new key.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CompileWarning } from './model.js';
import type { ApiModel } from './model.js';
import type { ToolDefinition, ToolWarning } from './tools/types.js';

/** Everything one compilation produced, plus the hashes that identify it. */
export interface CompiledSpec {
  /** The cache key: hash of compiler version + spec hash + overrides hash. */
  key: string;
  /** Hash of the spec content alone: the spec's version id, used for diffs. */
  specHash: string;
  overridesHash: string;
  compilerVersion: string;
  model: ApiModel;
  tools: ToolDefinition[];
  normalizeWarnings: CompileWarning[];
  toolWarnings: ToolWarning[];
}

export interface CompileCache {
  /** The entry for this key, or undefined on a miss. */
  get(key: string): Promise<CompiledSpec | undefined>;
  set(key: string, value: CompiledSpec): Promise<void>;
}

/** Keeps entries in a Map for the life of the process. */
export class MemoryCache implements CompileCache {
  private readonly entries = new Map<string, CompiledSpec>();

  /** Returns the stored entry, if any. */
  get(key: string): Promise<CompiledSpec | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  /** Stores the entry under its key. */
  set(key: string, value: CompiledSpec): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

const KEY_PATTERN = /^[a-f0-9]{64}$/;

/** One JSON file per entry: `<dir>/<key>.json`. */
export class FileCache implements CompileCache {
  /** `dir` is created on the first write. */
  constructor(private readonly dir: string) {}

  /**
   * Reads `<key>.json`. A missing, unreadable or mismatched file is a miss, not an error: the
   * worst case is one extra compile.
   */
  async get(key: string): Promise<CompiledSpec | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.path(key), 'utf8')) as CompiledSpec;
      return entry.key === key ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes to a temporary file, then renames it into place. A rename is atomic, so a reader never
   * sees a half-written entry, even if two processes compile the same spec at once.
   */
  async set(key: string, value: CompiledSpec): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(key);
    const temp = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, target);
  }

  /** The file for a key. Keys must be hex hashes, so a key can never point outside the folder. */
  private path(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid cache key: ${key}`);
    return join(this.dir, `${key}.json`);
  }
}
