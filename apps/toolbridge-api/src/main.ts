import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config));
configureApp(app, config);
app.enableShutdownHooks();

// 127.0.0.1 only: the platform API is not reachable from other machines on the network.
await app.listen(config.PLATFORM_PORT, '127.0.0.1');
console.log(`ToolBridge platform API on http://127.0.0.1:${String(config.PLATFORM_PORT)}`);
