import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_DUCKDB_MEMORY_LIMIT = '4GB';
export const DEFAULT_DUCKDB_THREADS = 4;

/** Which environment variables configure a process's DuckDB, and their defaults. */
export interface DuckDbEnvNames {
  /** `DUCKDB_` for the worker, `API_DUCKDB_` for the API. */
  prefix: string;
  defaultMemoryLimit: string;
  /** Folder under the OS temp directory used when `<prefix>TEMP_DIR` is empty. */
  defaultTempName: string;
}

export const WORKER_DUCKDB_ENV: DuckDbEnvNames = {
  prefix: 'DUCKDB_',
  defaultMemoryLimit: DEFAULT_DUCKDB_MEMORY_LIMIT,
  defaultTempName: 'ibero-duckdb',
};

/**
 * The API runs short queries (mapping checks, views, analyses), several at once, each in its own
 * DuckDB: the limit applies to each query, so it is lower than the worker's.
 */
export const API_DUCKDB_ENV: DuckDbEnvNames = {
  prefix: 'API_DUCKDB_',
  defaultMemoryLimit: '2GB',
  defaultTempName: 'ibero-duckdb-api',
};

export interface DuckDbSettings {
  memoryLimit: string;
  threads: number;
  /** Where DuckDB spills to disk when a job does not fit in `memoryLimit`. */
  tempDirectory: string;
}

export class DuckDbSettingsError extends Error {}

/**
 * `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS` and `DUCKDB_TEMP_DIR` (or the same with another
 * prefix, see `API_DUCKDB_ENV`), with their defaults. The memory limit is passed to DuckDB as
 * written, so DuckDB decides what is valid (`4GB`, `512MiB`, …); `checkDuckDbSettings` makes
 * the process refuse to start on a bad one.
 */
export function duckDbSettings(
  env: NodeJS.ProcessEnv = process.env,
  names: DuckDbEnvNames = WORKER_DUCKDB_ENV,
): DuckDbSettings {
  const { prefix } = names;
  const memoryLimit =
    env[`${prefix}MEMORY_LIMIT`]?.trim() || names.defaultMemoryLimit;

  const rawThreads = env[`${prefix}THREADS`]?.trim();
  let threads = DEFAULT_DUCKDB_THREADS;
  if (rawThreads) {
    threads = Number(rawThreads);
    if (
      !/^\d+$/.test(rawThreads) ||
      !Number.isSafeInteger(threads) ||
      threads < 1
    ) {
      throw new DuckDbSettingsError(
        `${prefix}THREADS must be a positive integer, got "${rawThreads}".`,
      );
    }
  }

  const rawTemp = env[`${prefix}TEMP_DIR`]?.trim();
  const tempDirectory = rawTemp
    ? resolve(rawTemp)
    : join(tmpdir(), names.defaultTempName);

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

/**
 * A fresh DuckDB with the worker's settings: in memory, or in a database file at `path` when the
 * data may not fit in memory. The temp directory is created first.
 */
export async function createWorkerDuckDb(
  settings: DuckDbSettings,
  path = ':memory:',
): Promise<DuckDBInstance> {
  await mkdir(settings.tempDirectory, { recursive: true });
  return DuckDBInstance.create(path, duckDbOptions(settings));
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

/** Opens DuckDB once with the settings, so a bad value stops the process at startup. */
export async function checkDuckDbSettings(
  settings: DuckDbSettings,
  names: DuckDbEnvNames = WORKER_DUCKDB_ENV,
) {
  const { prefix } = names;
  let instance: DuckDBInstance;
  try {
    instance = await createWorkerDuckDb(settings);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DuckDbSettingsError(
      `DuckDB rejected the settings (${prefix}MEMORY_LIMIT="${settings.memoryLimit}", ${prefix}THREADS=${settings.threads}, ${prefix}TEMP_DIR="${settings.tempDirectory}"): ${reason}`,
    );
  }
  try {
    return await appliedDuckDbSettings(instance);
  } finally {
    instance.closeSync();
  }
}
