/**
 * Every job the worker knows, by name, with its payload and its result. The API adds jobs
 * through `JobsService.add`, typed by this map; the worker registers one handler per name.
 */
export interface JobTypes {
  /** Checks the worker end to end: Redis, the separate process and the DuckDB settings. */
  diagnostic: {
    data: { requestedBy: string };
    result: {
      pid: number;
      duckdb: {
        version: string;
        memoryLimit: string;
        threads: number;
        tempDirectory: string;
      };
    };
  };
}

export type JobName = keyof JobTypes;
export type JobData<N extends JobName> = JobTypes[N]['data'];
export type JobResult<N extends JobName> = JobTypes[N]['result'];
