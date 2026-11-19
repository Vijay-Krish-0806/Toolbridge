import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import mongoose from 'mongoose';
import request, { type Response } from 'supertest';

import { loadConfig, type PlatformConfig } from '../src/config.js';

// Classes with NestJS decorators are loaded from dist/, compiled by tsc (which emits decorator
// metadata). Vitest's own TypeScript transform cannot compile them. Types still come from src/.
type AppModuleFile = typeof import('../src/app.module.js');
type BootstrapFile = typeof import('../src/bootstrap.js');
/** What supertest accepts as the app under test (Node's HTTP server here). */
export type App = Parameters<typeof request>[0];

const fromDist = async <T>(file: string): Promise<T> =>
  (await import(new URL(`../dist/${file}`, import.meta.url).href)) as T;

/** A fixed test-only admin key, so the tests never depend on the developer's real key. */
export const ADMIN_KEY = 'e2e-admin-key-0123456789-abcdefghijklmnop';

/** Fixed test-only master keys (base64 of 32 bytes), for encryption and rotation tests. */
export const MASTER_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
export const MASTER_KEY_V2 = Buffer.alloc(32, 2).toString('base64');

/** The host store spec, used as every tenant's sample API. */
export function hostSpec(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL('../../../specs/host-store.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

/** The host store overrides file (hides plumbing, merges lookups, sets risk). */
export function hostOverrides(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL('../../../specs/host-store.overrides.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

export interface Harness {
  app: INestApplication;
  http: App;
  config: PlatformConfig;
}

/**
 * Boots the real app in-process on an empty e2e database (never your development data), with
 * small limits so each one can be hit: 3 specs per tenant, 512 KB bodies, a 2 s fetch timeout,
 * and only "localhost" allowed to resolve to a private address.
 * `env` overrides settings (for example the master key); `keepDatabase` restarts on the same data.
 */
export async function startHarness(
  env: Record<string, string> = {},
  options: { keepDatabase?: boolean } = {},
): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    PLATFORM_MONGO_DB: 'toolbridge_e2e',
    PLATFORM_ADMIN_KEY: ADMIN_KEY,
    PLATFORM_ALLOW_PRIVATE_HOSTS: 'localhost',
    MAX_SPECS_PER_TENANT: '3',
    MAX_SPEC_BYTES: String(512 * 1024),
    SPEC_FETCH_TIMEOUT_MS: '2000',
    PLATFORM_MASTER_KEY: MASTER_KEY_V1,
    PLATFORM_MASTER_KEY_VERSION: 'v1',
    PLATFORM_PREVIOUS_MASTER_KEYS: '',
    ...env,
  });
  const connection = await mongoose
    .createConnection(config.MONGO_URI, { dbName: config.PLATFORM_MONGO_DB })
    .asPromise();
  try {
    if (!options.keepDatabase) await connection.dropDatabase();
  } finally {
    await connection.close();
  }

  const { AppModule } = await fromDist<AppModuleFile>('app.module.js');
  const { configureApp } = await fromDist<BootstrapFile>('bootstrap.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: false,
  });
  configureApp(app, config);
  await app.init();
  return { app, http: app.getHttpServer() as App, config };
}

/** Creates a tenant through the admin API; returns its id and first API key. */
export async function createTenant(http: App, name: string): Promise<{ id: string; key: string }> {
  const response = await request(http)
    .post('/admin/tenants')
    .set('authorization', `Bearer ${ADMIN_KEY}`)
    .send({ name })
    .expect(201);
  const created = body<{ tenant: { id: string }; apiKey: string }>(response);
  return { id: created.tenant.id, key: created.apiKey };
}

/** Typed access to a JSON response body. */
export function body<T>(response: Response & { body: T }): T {
  const value: unknown = response.body; // supertest types the body as any
  return value as T;
}
