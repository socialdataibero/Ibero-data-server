import { Global, Logger, Module } from '@nestjs/common';
import {
  API_DUCKDB_ENV,
  checkDuckDbSettings,
  duckDbOptions,
  duckDbSettings,
} from '../../worker/duckdb-settings.js';
import { ANALYSIS_DUCKDB_OPTIONS } from './analysis.service.js';

/**
 * DuckDB settings of the API process (`API_DUCKDB_MEMORY_LIMIT`, `API_DUCKDB_THREADS`,
 * `API_DUCKDB_TEMP_DIR`) for every query `AnalysisService` runs. Each query opens its own
 * DuckDB, so the memory limit applies to each query: one large query spills to disk instead of
 * taking the API's memory. A value DuckDB rejects stops the API at startup. The worker has
 * its own settings (worker.module.ts).
 */
@Global()
@Module({
  providers: [
    {
      provide: ANALYSIS_DUCKDB_OPTIONS,
      useFactory: async () => {
        const settings = duckDbSettings(process.env, API_DUCKDB_ENV);
        const applied = await checkDuckDbSettings(settings, API_DUCKDB_ENV);
        new Logger('ApiDuckDb').log(
          `DuckDB ${applied.version} for API queries: memory_limit ${applied.memoryLimit} per query, threads ${applied.threads}, temp_directory ${applied.tempDirectory}`,
        );
        return duckDbOptions(settings);
      },
    },
  ],
  exports: [ANALYSIS_DUCKDB_OPTIONS],
})
export class ApiDuckDbModule {}
