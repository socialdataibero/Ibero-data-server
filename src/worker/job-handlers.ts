import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { JobData, JobName, JobResult } from '../modules/jobs/job-types.js';
import { HarmonizerImportProcessor } from '../modules/harmonizer/import/import-processor.js';
import { WorkerDuckDb } from './worker-duckdb.js';

export type JobOf<N extends JobName> = Job<JobData<N>, JobResult<N>, N>;

/** One handler per job name. A job name without a handler does not compile. */
export type JobHandlerMap = {
  [N in JobName]: (job: JobOf<N>) => Promise<JobResult<N>>;
};

@Injectable()
export class JobHandlers implements JobHandlerMap {
  constructor(
    private readonly duckdb: WorkerDuckDb,
    private readonly imports: HarmonizerImportProcessor,
  ) {}

  harmonizerImport(
    job: JobOf<'harmonizerImport'>,
  ): Promise<JobResult<'harmonizerImport'>> {
    return this.imports.process(job.data.importId);
  }

  async diagnostic(): Promise<JobResult<'diagnostic'>> {
    return { pid: process.pid, duckdb: await this.duckdb.applied() };
  }
}
