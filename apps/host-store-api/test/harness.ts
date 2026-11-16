import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import request, { type Response } from 'supertest';
import { loadConfig, type HostConfig } from '../src/config.js';
import { ROLES, type Role } from '../src/domain/user.schema.js';
import { generateDataset, type Dataset } from '../src/seed/generate.js';
import { writeDataset } from '../src/seed/write.js';

// Classes with NestJS decorators are loaded from dist/, compiled by tsc (which emits decorator
// metadata). Vitest's own TypeScript transform cannot compile them. Types still come from src/.
type AppModuleFile = typeof import('../src/app.module.js');
type BootstrapFile = typeof import('../src/bootstrap.js');
/** What supertest accepts as the app under test (Node's HTTP server here). */
type App = Parameters<typeof request>[0];

const fromDist = async <T>(file: string): Promise<T> =>
  (await import(new URL(`../dist/${file}`, import.meta.url).href)) as T;

export interface Harness {
  app: INestApplication;
  http: App;
  config: HostConfig;
  /** The data the test database was seeded with. */
  data: Dataset;
  tokens: Record<Role, string>;
}

/**
 * Seeds a separate e2e database (never your development data), then boots the real app
 * in-process. Supertest sends requests straight to it, without opening a network port.
 */
export async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    MONGO_DB: `${process.env.MONGO_DB ?? 'host_store'}_e2e`,
  });
  const data = generateDataset(config.SEED_STAFF_PASSWORD);
  const connection = await mongoose
    .createConnection(config.MONGO_URI, { dbName: config.MONGO_DB, autoIndex: false })
    .asPromise();
  try {
    await writeDataset(connection, data);
  } finally {
    await connection.close();
  }

  const { AppModule } = await fromDist<AppModuleFile>('app.module.js');
  const { configureApp } = await fromDist<BootstrapFile>('bootstrap.js');
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  configureApp(app);
  await app.init();
  const http = app.getHttpServer() as App;

  const tokens = {} as Record<Role, string>;
  for (const role of ROLES) {
    const response = await request(http)
      .post('/auth/login')
      .send({ email: `${role}@store.example`, password: config.SEED_STAFF_PASSWORD })
      .expect(200);
    tokens[role] = body<{ accessToken: string }>(response).accessToken;
  }
  return { app, http, config, data, tokens };
}

/** Typed access to a JSON response body. */
export function body<T>(response: Response & { body: T }): T {
  const value: unknown = response.body; // supertest types the body as any
  return value as T;
}

/** Signs an HS256 JWT by hand, to build tokens the API would never issue (expired, forged). */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
