import type {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBInstance,
} from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createWorkerDuckDb,
  type DuckDbSettings,
} from '../../../worker/duckdb-settings.js';

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Writes an edition's rows to its raw Parquet (all VARCHAR, positional columns `c0…cN`, file
 * order), the same file the synchronous upload writes with `writeRowsToParquet`. Rows go
 * through a DuckDB database file in the temp directory, so a file larger than the memory limit
 * spills to disk instead of failing.
 */
export class RawParquetWriter {
  private closed = false;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly appender: DuckDBAppender,
    private readonly dbPath: string,
    private readonly width: number,
  ) {}

  static async open(
    settings: DuckDbSettings,
    columnCount: number,
  ): Promise<RawParquetWriter> {
    const dbPath = join(
      settings.tempDirectory,
      `import-${randomUUID()}.duckdb`,
    );
    const instance = await createWorkerDuckDb(settings, dbPath);
    try {
      const connection = await instance.connect();
      const columns = Array.from(
        { length: columnCount },
        (_, i) => `c${i} VARCHAR`,
      ).join(', ');
      await connection.run(`CREATE TABLE raw_rows (${columns})`);
      const appender = await connection.createAppender('raw_rows');
      return new RawParquetWriter(
        instance,
        connection,
        appender,
        dbPath,
        columnCount,
      );
    } catch (err) {
      instance.closeSync();
      await removeDbFiles(dbPath);
      throw err;
    }
  }

  append(values: readonly string[]): void {
    for (let i = 0; i < this.width; i++)
      this.appender.appendVarchar(values[i] ?? '');
    this.appender.endRow();
  }

  /** Writes the Parquet to `destPath` and deletes the temporary database. */
  async finish(destPath: string): Promise<void> {
    try {
      this.appender.closeSync();
      await this.connection.run(
        `COPY raw_rows TO '${escapeSqlLiteral(destPath)}' (FORMAT PARQUET)`,
      );
    } finally {
      await this.close();
    }
  }

  /** Discards everything written so far. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.closeSync();
      this.instance.closeSync();
    } finally {
      await removeDbFiles(this.dbPath);
    }
  }
}

async function removeDbFiles(dbPath: string): Promise<void> {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}.wal`, { force: true });
}
