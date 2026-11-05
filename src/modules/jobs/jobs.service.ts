import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { JOBS_QUEUE, redisConnection } from './jobs.config.js';
import type { JobData, JobName, JobResult } from './job-types.js';
import { redisErrorLogger } from './redis-error-log.js';

export type JobState =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children'
  | 'unknown';

export interface JobStatus<N extends JobName = JobName> {
  id: string;
  name: N;
  state: JobState;
  progress: unknown;
  result: JobResult<N> | null;
  failedReason: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * Defaults for every job. One attempt: a job that fails on its input (a bad file) would fail
 * again. A job whose worker dies is retried once by BullMQ's stalled-job check. Finished jobs
 * are kept a while so their status can still be read, then removed.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 1000 },
};

/** Adds jobs to the queue and reads their status. The jobs run in the worker process. */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly queue = new Queue(JOBS_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  constructor() {
    // Without a listener, an 'error' event (Redis down) would crash the process.
    this.queue.on('error', redisErrorLogger(this.logger, 'Redis queue error'));
  }

  async add<N extends JobName>(
    name: N,
    data: JobData<N>,
    opts: JobsOptions = {},
  ): Promise<string> {
    const job = await this.queue.add(name, data, opts);
    if (!job.id)
      throw new Error(`The queue did not return an id for job "${name}".`);
    return job.id;
  }

  async status(id: string): Promise<JobStatus | null> {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    return {
      id,
      name: job.name as JobName,
      state: (await job.getState()) as JobState,
      progress: job.progress,
      result: (job.returnvalue as JobResult<JobName> | undefined) ?? null,
      failedReason: job.failedReason || null,
      createdAt: job.timestamp,
      startedAt: job.processedOn ?? null,
      finishedAt: job.finishedOn ?? null,
    };
  }

  /** Removes a job that is not running, so it can be added again with the same id. */
  async remove(id: string): Promise<void> {
    await this.queue.remove(id);
  }

  /** Worker processes connected to the queue right now. */
  async workerCount(): Promise<number> {
    return (await this.queue.getWorkers()).length;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
