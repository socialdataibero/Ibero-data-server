import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { JobData, JobName, JobResult } from '../modules/jobs/job-types.js';
import { WorkerDuckDb } from './worker-duckdb.js';

export type JobOf<N extends JobName> = Job<JobData<N>, JobResult<N>, N>;

/** One handler per job name. A job name without a handler does not compile. */
export type JobHandlerMap = {
  [N in JobName]: (job: JobOf<N>) => Promise<JobResult<N>>;
};

@Injectable()
export class JobHandlers implements JobHandlerMap {
  constructor(private readonly duckdb: WorkerDuckDb) {}

  async diagnostic(): Promise<JobResult<'diagnostic'>> {
    return { pid: process.pid, duckdb: await this.duckdb.applied() };
  }
}
