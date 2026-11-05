import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JobHandlers } from './job-handlers.js';
import { WorkerDuckDb } from './worker-duckdb.js';
import { WorkerService } from './worker.service.js';

/** Everything the worker process loads. It has no HTTP server. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [WorkerDuckDb, JobHandlers, WorkerService],
})
export class WorkerModule {}
