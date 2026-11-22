/**
 * The worker program (Step 4.4a): takes run legs from the queue and runs them. It serves no HTTP.
 * Run as many copies as you like: BullMQ gives each job to one worker at a time, and a worker
 * that dies has its job taken over by another one (from the run's last checkpoint).
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { loadConfig, WorkerModule } from '@toolbridge/toolbridge-api/worker';

const config = loadConfig();
const worker = await NestFactory.createApplicationContext(WorkerModule.register(config));
// SIGTERM / SIGINT -> close(): stop taking jobs and let running legs finish (graceful shutdown).
worker.enableShutdownHooks();
console.log(
  `ToolBridge worker started (queue prefix "${config.RUN_QUEUE_PREFIX}", concurrency ${String(config.WORKER_CONCURRENCY)})`,
);
