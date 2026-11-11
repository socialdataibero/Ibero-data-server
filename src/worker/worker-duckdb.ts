import { Injectable } from '@nestjs/common';
import type { DuckDBInstance } from '@duckdb/node-api';
import {
  appliedDuckDbSettings,
  createWorkerDuckDb,
  duckDbSettings,
  type DuckDbSettings,
} from './duckdb-settings.js';

/** DuckDB for job handlers, always opened with the worker's settings. */
@Injectable()
export class WorkerDuckDb {
  readonly settings: DuckDbSettings = duckDbSettings();

  /** Runs `fn` with a fresh in-memory DuckDB and closes it afterwards. */
  async with<T>(fn: (instance: DuckDBInstance) => Promise<T>): Promise<T> {
    const instance = await createWorkerDuckDb(this.settings);
    try {
      return await fn(instance);
    } finally {
      instance.closeSync();
    }
  }

  applied() {
    return this.with(appliedDuckDbSettings);
  }
}
