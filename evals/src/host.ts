/**
 * The host store for evals: its own process, port and database, so a run never touches the
 * development data. It is only started and called from outside: evals do not import host code.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createOpenApiTools,
  SafeHttpClient,
  TokenLogin,
  type Tool,
  ToolExecutor,
  ToolRegistry,
} from '@toolbridge/agent-core';
import { MongoClient } from 'mongodb';
import { z } from 'zod';

import { type EvalCase, root } from './dataset.js';
import type { StoreTools } from './store-tools.js';
import { readWorld, type World } from './world.js';

/** Fixed on purpose: a reset drops this database, so its name must never come from a setting. */
const EVAL_DB = 'host_store_eval';
/** The instant the seed data is frozen at (REFERENCE_NOW in the host's seed). */
const SEED_NOW = '2026-11-01T00:00:00.000Z';
const HOST_DIR = resolve(root, 'apps/host-store-api');

const envSchema = z.object({
  MONGO_URI: z.string().min(1),
  SEED_STAFF_PASSWORD: z.string().min(1),
  EVAL_HOST_PORT: z.coerce.number().int().min(1).max(65_535).default(3190),
});

export class EvalHost {
  /** Use `EvalHost.start`. */
  private constructor(
    private readonly child: ChildProcess,
    private readonly mongo: MongoClient,
    private readonly baseUrl: string,
    private readonly password: string,
    private readonly store: StoreTools,
  ) {}

  /** Seeds the eval database, starts the host on it, and waits until it answers. */
  static async start(store: StoreTools): Promise<EvalHost> {
    const env = envSchema.parse(process.env);
    const baseUrl = `http://127.0.0.1:${String(env.EVAL_HOST_PORT)}`;
    // Another server on this port would be tested instead of ours, on an unknown database.
    if (await answers(baseUrl))
      throw new Error(`Something already listens on ${baseUrl}. Stop it or set EVAL_HOST_PORT.`);
    await seed();
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: HOST_DIR,
      env: { ...hostEnv(), PORT: String(env.EVAL_HOST_PORT) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const mongo = new MongoClient(env.MONGO_URI);
    const host = new EvalHost(child, mongo, baseUrl, env.SEED_STAFF_PASSWORD, store);
    try {
      for (let i = 0; !(await answers(baseUrl)); i++) {
        if (child.exitCode !== null) throw new Error('The eval host stopped while starting.');
        if (i > 120) throw new Error('The eval host did not answer within 60 s.');
        await sleep(500);
      }
      await mongo.connect();
    } catch (error) {
      await host.stop();
      throw error;
    }
    return host;
  }

  /** Puts the database back to exactly the seed. Logins stay valid: seeded user ids never change. */
  reset(): Promise<void> {
    return seed();
  }

  /** The database as it is now. */
  world(): Promise<World> {
    return readWorld(this.mongo.db(EVAL_DB));
  }

  /** The store's tools, calling this host as the seeded user of the role. */
  toolsFor(role: EvalCase['role']): Tool[] {
    const client = new SafeHttpClient({ allowPrivateHosts: [new URL(this.baseUrl).hostname] });
    return createOpenApiTools(this.store.tools, {
      baseUrl: this.baseUrl,
      securitySchemes: this.store.model.securitySchemes,
      client,
      auth: new TokenLogin({
        client,
        loginUrl: new URL('/auth/login', this.baseUrl),
        credentials: { email: `${role}@store.example`, password: this.password },
        tokenField: 'accessToken',
      }),
    });
  }

  /**
   * An executor for those tools without a policy: the replay wants the HOST's own answer, also for
   * calls our policy would stop earlier.
   */
  executorFor(role: EvalCase['role']): ToolExecutor {
    const registry = new ToolRegistry(this.toolsFor(role));
    return new ToolExecutor(registry, { maxResultChars: 1_000_000 });
  }

  /** Stops the host process and closes the database connection. */
  async stop(): Promise<void> {
    await this.mongo.close();
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, 'exit');
    this.child.kill();
    await exited;
  }
}

/** The environment of the host's processes: ours, but with the eval database and frozen time. */
function hostEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MONGO_DB: EVAL_DB, HOST_CLOCK_NOW: SEED_NOW, NODE_ENV: 'test' };
}

/** Runs the host's own seed script against the eval database. */
async function seed(): Promise<void> {
  const child = spawn(process.execPath, ['dist/seed/main.js'], {
    cwd: HOST_DIR,
    env: hostEnv(),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`Seeding ${EVAL_DB} failed (exit code ${String(code)}).`);
}

/** True when something answers HTTP at this address. */
async function answers(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}
