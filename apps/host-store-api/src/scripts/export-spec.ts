/**
 * Writes the OpenAPI document to specs/host-store.json. ToolBridge compiles its tools from this
 * file, so it is committed, and CI fails if it is out of date with the code.
 *
 * Needs no database and starts no HTTP server: it only builds the app to read routes and DTOs.
 * Run: pnpm export:spec
 */
import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { createOpenApiDocument } from '../bootstrap.js';
import { loadConfig } from '../config.js';

const OUTPUT = new URL('../../../../specs/host-store.json', import.meta.url);

const app = await NestFactory.create(AppModule.register(loadConfig(), { lazyDatabase: true }), {
  logger: false,
});
const document = createOpenApiDocument(app);
await app.close();

await mkdir(new URL('.', OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
const operations = Object.values(document.paths).flatMap((methods) => Object.keys(methods)).length;
console.log(`Wrote ${fileURLToPath(OUTPUT)} (${String(operations)} operations).`);
