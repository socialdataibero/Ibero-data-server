import { FileStore } from '@tus/file-store';
import type { DataStore } from '@tus/utils';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const DEFAULT_UPLOAD_MAX_BYTES = 10 * GIB;
/** A DBF is read whole into memory (`readDbf`), so it keeps the old upload limit. */
export const DEFAULT_DBF_MAX_BYTES = 200 * MIB;
/** An unfinished upload is deleted this long after it started. */
export const DEFAULT_UPLOAD_EXPIRATION_HOURS = 24;

export class UploadConfigError extends Error {}

/** Nest token for the `UploadStorage` both processes use. */
export const UPLOAD_STORAGE = Symbol('UPLOAD_STORAGE');

export interface UploadConfig {
  /** Where unfinished and finished-but-not-yet-imported uploads are kept. */
  dir: string;
  maxBytes: number;
  /** Largest CSV inside a `.csv.gz`, once decompressed. */
  maxUncompressedBytes: number;
  dbfMaxBytes: number;
  expirationMs: number;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new UploadConfigError(
      `${name} must be a positive integer, got "${raw}".`,
    );
  }
  return value;
}

/**
 * `UPLOAD_DIR` (default `storage/uploads` under the working directory, like `storage/`),
 * `UPLOAD_MAX_BYTES` (10 GiB), `UPLOAD_MAX_UNCOMPRESSED_BYTES` (default `UPLOAD_MAX_BYTES`: a
 * `.csv.gz` cannot hold more than could be uploaded uncompressed), `DBF_MAX_BYTES` (200 MiB) and
 * `UPLOAD_EXPIRATION_HOURS` (24).
 */
export function uploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): UploadConfig {
  const dir = env.UPLOAD_DIR?.trim();
  const maxBytes = positiveInteger(
    env,
    'UPLOAD_MAX_BYTES',
    DEFAULT_UPLOAD_MAX_BYTES,
  );
  return {
    dir: dir ? resolve(dir) : resolve(process.cwd(), 'storage', 'uploads'),
    maxBytes,
    maxUncompressedBytes: positiveInteger(
      env,
      'UPLOAD_MAX_UNCOMPRESSED_BYTES',
      maxBytes,
    ),
    dbfMaxBytes: positiveInteger(env, 'DBF_MAX_BYTES', DEFAULT_DBF_MAX_BYTES),
    expirationMs:
      positiveInteger(
        env,
        'UPLOAD_EXPIRATION_HOURS',
        DEFAULT_UPLOAD_EXPIRATION_HOURS,
      ) * 3600_000,
  };
}

/**
 * Where tus uploads live, seen from both processes: the API's tus server writes through
 * `datastore`; the worker reads a finished upload as a local file. Only a local folder exists
 * today (`@tus/file-store`). An S3 version (`@tus/s3-store`) would implement `open` by
 * downloading the object to a temporary file and `release` by deleting that copy.
 */
export interface UploadStorage {
  readonly datastore: DataStore;
  /** A local path to the whole uploaded file. Call `release` when done reading it. */
  open(id: string): Promise<{ path: string; release(): Promise<void> }>;
  /** Deletes the upload and its tus metadata. Missing uploads are ignored. */
  remove(id: string): Promise<void>;
  /** Deletes unfinished uploads older than the expiration. Returns how many. */
  deleteExpired(): Promise<number>;
}

export class LocalUploadStorage implements UploadStorage {
  readonly datastore: FileStore;

  constructor(private readonly config: UploadConfig) {
    this.datastore = new FileStore({
      directory: config.dir,
      expirationPeriodInMilliseconds: config.expirationMs,
    });
  }

  open(id: string) {
    return Promise.resolve({
      path: join(this.config.dir, id),
      release: () => Promise.resolve(),
    });
  }

  async remove(id: string): Promise<void> {
    // FileStore.remove throws when the data file is already gone; remove both files directly.
    await rm(join(this.config.dir, id), { force: true });
    await rm(join(this.config.dir, `${id}.json`), { force: true });
  }

  deleteExpired(): Promise<number> {
    return this.datastore.deleteExpired();
  }
}

export function createUploadStorage(
  config: UploadConfig = uploadConfig(),
): UploadStorage {
  return new LocalUploadStorage(config);
}
