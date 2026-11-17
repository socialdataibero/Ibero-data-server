import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';

/**
 * Entry point of the worker process, separate from the API (main.ts). It runs the background
 * jobs from Redis (BullMQ) and the heavy DuckDB work, so they cannot take the API down.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}
await bootstrap();
