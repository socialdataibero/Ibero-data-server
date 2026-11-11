import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  JOBS_QUEUE,
  redisConnection,
  redisUrl,
  safeRedisUrl,
  workerConcurrency,
} from '../modules/jobs/jobs.config.js';
import type { JobName } from '../modules/jobs/job-types.js';
import { redisErrorLogger } from '../modules/jobs/redis-error-log.js';
import { checkDuckDbSettings } from './duckdb-settings.js';
import { JobHandlers, type JobHandlerMap } from './job-handlers.js';
import { WorkerDuckDb } from './worker-duckdb.js';

/** Takes jobs from the queue and runs each one with its handler. */
@Injectable()
export class WorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerService.name);
  private worker: Worker | null = null;

  constructor(
    private readonly handlers: JobHandlers,
    private readonly duckdb: WorkerDuckDb,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A bad DUCKDB_* value stops the worker now instead of failing every job.
    const applied = await checkDuckDbSettings(this.duckdb.settings);
    const concurrency = workerConcurrency();

    this.worker = new Worker(JOBS_QUEUE, (job) => this.run(job), {
      connection: redisConnection(),
      concurrency,
    });
    this.worker.on(
      'error',
      redisErrorLogger(this.logger, 'Redis worker error'),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`Job ${job?.name} ${job?.id} failed: ${err.message}`),
    );
    this.worker.on('completed', (job) =>
      this.logger.log(
        `Job ${job.name} ${job.id} completed in ${(job.finishedOn ?? 0) - (job.processedOn ?? 0)} ms`,
      ),
    );
    this.logger.log(`Connecting to Redis at ${safeRedisUrl(redisUrl())}…`);
    await this.worker.waitUntilReady();

    this.logger.log(
      `Worker ${process.pid} listening on "${JOBS_QUEUE}", concurrency ${concurrency}. DuckDB ${applied.version}: memory_limit ${applied.memoryLimit}, threads ${applied.threads}, temp_directory ${applied.tempDirectory}`,
    );
  }

  private async run(job: Job): Promise<unknown> {
    const name = job.name as JobName;
    if (!Object.hasOwn(JobHandlers.prototype, name)) {
      // Retrying will not make an unknown job known.
      throw new UnrecoverableError(`No handler for job "${job.name}".`);
    }
    this.logger.log(`Job ${job.name} ${job.id} started`);
    const handler = this.handlers[name] as (
      job: Job,
    ) => ReturnType<JobHandlerMap[JobName]>;
    return handler.call(this.handlers, job);
  }

  /** Waits for the running jobs to finish before the process exits (SIGTERM, SIGINT). */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.worker) return;
    this.logger.log(
      `Stopping worker${signal ? ` (${signal})` : ''}; waiting for running jobs.`,
    );
    await this.worker.close();
  }
}
