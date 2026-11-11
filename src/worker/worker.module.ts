import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../modules/prisma/prisma.module.js';
import { StorageModule } from '../modules/storage/storage.module.js';
import { AnalysisModule } from '../modules/analysis/analysis.module.js';
import { ANALYSIS_DUCKDB_OPTIONS } from '../modules/analysis/analysis.service.js';
import { HarmonizerImportProcessor } from '../modules/harmonizer/import/import-processor.js';
import {
  UPLOAD_STORAGE,
  createUploadStorage,
} from '../modules/harmonizer/import/upload-storage.js';
import { duckDbOptions } from './duckdb-settings.js';
import { JobHandlers } from './job-handlers.js';
import { WorkerDuckDb } from './worker-duckdb.js';
import { WorkerService } from './worker.service.js';

/**
 * DuckDB settings for the whole worker: its own DuckDB (`WorkerDuckDb`) and the shared
 * `AnalysisService` both use `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS` and `DUCKDB_TEMP_DIR`.
 */
@Global()
@Module({
  providers: [
    WorkerDuckDb,
    {
      provide: ANALYSIS_DUCKDB_OPTIONS,
      inject: [WorkerDuckDb],
      useFactory: (duckdb: WorkerDuckDb) => duckDbOptions(duckdb.settings),
    },
  ],
  exports: [WorkerDuckDb, ANALYSIS_DUCKDB_OPTIONS],
})
class WorkerDuckDbModule {}

/** Everything the worker process loads. It has no HTTP server. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    WorkerDuckDbModule,
    PrismaModule,
    StorageModule,
    AnalysisModule,
  ],
  providers: [
    { provide: UPLOAD_STORAGE, useFactory: () => createUploadStorage() },
    HarmonizerImportProcessor,
    JobHandlers,
    WorkerService,
  ],
})
export class WorkerModule {}
