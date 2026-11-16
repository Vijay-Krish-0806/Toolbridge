import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp, createOpenApiDocument } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await NestFactory.create(AppModule.register(config));
configureApp(app);
app.enableShutdownHooks();
SwaggerModule.setup('docs', app, () => createOpenApiDocument(app), {
  jsonDocumentUrl: 'docs/json',
});

// 127.0.0.1 only: the API is not reachable from other machines on the network.
await app.listen(config.PORT, '127.0.0.1');
console.log(`Host Store API on http://127.0.0.1:${String(config.PORT)} (docs at /docs)`);
