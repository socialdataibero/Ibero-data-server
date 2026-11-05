import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_DUCKDB_MEMORY_LIMIT = '4GB';
export const DEFAULT_DUCKDB_THREADS = 4;

export interface DuckDbSettings {
  memoryLimit: string;
  threads: number;
  /** Where DuckDB spills to disk when a job does not fit in `memoryLimit`. */
  tempDirectory: string;
}

export class DuckDbSettingsError extends Error {}

/**
 * `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS` and `DUCKDB_TEMP_DIR`, with their defaults. The
 * memory limit is passed to DuckDB as written, so DuckDB decides what is valid (`4GB`,
 * `512MiB`, …); `checkDuckDbSettings` makes the worker refuse to start on a bad one.
 */
export function duckDbSettings(
  env: NodeJS.ProcessEnv = process.env,
): DuckDbSettings {
  const memoryLimit =
    env.DUCKDB_MEMORY_LIMIT?.trim() || DEFAULT_DUCKDB_MEMORY_LIMIT;

  const rawThreads = env.DUCKDB_THREADS?.trim();
  let threads = DEFAULT_DUCKDB_THREADS;
  if (rawThreads) {
    threads = Number(rawThreads);
    if (
      !/^\d+$/.test(rawThreads) ||
      !Number.isSafeInteger(threads) ||
      threads < 1
    ) {
      throw new DuckDbSettingsError(
        `DUCKDB_THREADS must be a positive integer, got "${rawThreads}".`,
      );
    }
  }

  const rawTemp = env.DUCKDB_TEMP_DIR?.trim();
  const tempDirectory = rawTemp
    ? resolve(rawTemp)
    : join(tmpdir(), 'ibero-duckdb');

  return { memoryLimit, threads, tempDirectory };
}

/** Options for `DuckDBInstance.create`, the names DuckDB uses. */
export function duckDbOptions(
  settings: DuckDbSettings,
): Record<string, string> {
  return {
    memory_limit: settings.memoryLimit,
    threads: String(settings.threads),
    temp_directory: settings.tempDirectory,
  };
}

/** A fresh in-memory DuckDB with the worker's settings. The temp directory is created first. */
export async function createWorkerDuckDb(
  settings: DuckDbSettings,
): Promise<DuckDBInstance> {
  await mkdir(settings.tempDirectory, { recursive: true });
  return DuckDBInstance.create(':memory:', duckDbOptions(settings));
}

/** What DuckDB actually applied, read back from a connection. */
export async function appliedDuckDbSettings(instance: DuckDBInstance) {
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT version(), current_setting('memory_limit'), current_setting('threads'), current_setting('temp_directory')`,
    );
    const [version, memoryLimit, threads, tempDirectory] = reader.getRows()[0];
    return {
      version: String(version),
      memoryLimit: String(memoryLimit),
      threads: Number(threads),
      tempDirectory: String(tempDirectory),
    };
  } finally {
    connection.closeSync();
  }
}

/** Opens DuckDB once with the settings, so a bad value stops the worker at startup. */
export async function checkDuckDbSettings(settings: DuckDbSettings) {
  let instance: DuckDBInstance;
  try {
    instance = await createWorkerDuckDb(settings);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DuckDbSettingsError(
      `DuckDB rejected the settings (DUCKDB_MEMORY_LIMIT="${settings.memoryLimit}", DUCKDB_THREADS=${settings.threads}, DUCKDB_TEMP_DIR="${settings.tempDirectory}"): ${reason}`,
    );
  }
  try {
    return await appliedDuckDbSettings(instance);
  } finally {
    instance.closeSync();
  }
}
