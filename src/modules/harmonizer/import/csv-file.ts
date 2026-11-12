import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { csvNotUtf8Body } from '../csv-errors.js';
import type { DuckDbSettings } from '../../../worker/duckdb-settings.js';
import { readCsvRows, type CsvHeader } from './csv-rows.js';
import { ImportError } from './import-error.js';
import { RawParquetWriter } from './raw-parquet-writer.js';
import { Utf8LineChecker } from './utf8-check.js';

export type ImportPhase = 'checking' | 'reading' | 'saving';

export interface CsvFileImport {
  /** The uploaded file on local disk. */
  path: string;
  /** The upload is a gzip-compressed CSV (`.csv.gz`). */
  gzip: boolean;
  /** Largest CSV a `.csv.gz` may decompress to (`UPLOAD_MAX_UNCOMPRESSED_BYTES`). */
  maxUncompressedBytes: number;
  settings: DuckDbSettings;
  /** Where to write the raw Parquet. */
  parquetPath: string;
  /** Where to keep the original CSV, gzip-compressed. */
  originalPath: string;
  onProgress?: (progress: { phase: ImportPhase; rowsRead: number }) => void;
}

const PROGRESS_EVERY_ROWS = 50_000;

function gzipInvalid(): ImportError {
  return new ImportError(400, 'gzip_invalid', {
    message:
      'The file ends in .gz but is not a complete gzip file. Compress the CSV again, or upload it uncompressed.',
  });
}

/**
 * A `.csv.gz` whose CSV is larger than the limit. Found while decompressing, before anything is
 * parsed or written: a small file that decompresses to a huge one would otherwise fill the
 * worker's disk and keep it busy.
 */
function gzipTooLarge(maxBytes: number): ImportError {
  return new ImportError(413, 'gzip_too_large', {
    message: `The CSV inside this .gz file is larger than ${maxBytes} bytes once decompressed. Split it into smaller files.`,
    params: { maxBytes },
  });
}

function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}

/** The file as CSV bytes: decompressed when it is a `.csv.gz`. */
function csvBytes(path: string, gzip: boolean): Readable {
  const raw = createReadStream(path, { highWaterMark: 1 << 20 });
  if (!gzip) return raw;
  const gunzip = createGunzip();
  raw.on('error', (err) => gunzip.destroy(err));
  return raw.pipe(gunzip);
}

/**
 * Imports an uploaded CSV (or `.csv.gz`) without holding it in memory, in two passes:
 *
 * 1. `checking`: the whole file must be UTF-8 (`csv_not_utf8` with the line), checked before
 *    anything is parsed, as the synchronous upload does. A `.csv.gz` must not decompress to more
 *    than `maxUncompressedBytes` (`gzip_too_large`). The original is kept gzip-compressed at
 *    `originalPath` (a `.csv.gz` upload is copied as it is).
 * 2. `reading`: rows are parsed with the same rules as the synchronous upload and written to
 *    the raw Parquet.
 *
 * On any error, the files written so far are deleted and the error is thrown.
 */
export async function importCsvFile(
  job: CsvFileImport,
): Promise<{ header: CsvHeader; rowCount: number }> {
  try {
    job.onProgress?.({ phase: 'checking', rowsRead: 0 });
    await checkAndKeepOriginal(job);

    job.onProgress?.({ phase: 'reading', rowsRead: 0 });
    // Opened when the header arrives: its width is the number of columns.
    const out: { writer: RawParquetWriter | null } = { writer: null };
    try {
      let rowsRead = 0;
      const result = await readCsvRows(
        csvBytes(job.path, job.gzip),
        async ({ columns }) => {
          out.writer = await RawParquetWriter.open(
            job.settings,
            columns.length,
          );
        },
        (values) => {
          out.writer!.append(values);
          rowsRead++;
          if (rowsRead % PROGRESS_EVERY_ROWS === 0)
            job.onProgress?.({ phase: 'reading', rowsRead });
        },
      );
      job.onProgress?.({ phase: 'saving', rowsRead: result.rowCount });
      await out.writer!.finish(job.parquetPath);
      return result;
    } finally {
      await out.writer?.close();
    }
  } catch (err) {
    await rm(job.parquetPath, { force: true });
    await rm(job.originalPath, { force: true });
    if (job.gzip && isZlibError(err)) throw gzipInvalid();
    throw err;
  }
}

async function checkAndKeepOriginal(job: CsvFileImport): Promise<void> {
  const checker = new Utf8LineChecker();
  const fail = (line: number) =>
    new ImportError(400, 'csv_not_utf8', csvNotUtf8Body(line));
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const line = checker.push(chunk);
      callback(line === null ? null : fail(line), chunk);
    },
    flush(callback) {
      const line = checker.end();
      callback(line === null ? null : fail(line));
    },
  });

  if (job.gzip) {
    let decompressed = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        decompressed += chunk.length;
        callback(
          decompressed > job.maxUncompressedBytes
            ? gzipTooLarge(job.maxUncompressedBytes)
            : null,
          chunk,
        );
      },
    });
    const discard = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    });
    await pipeline(csvBytes(job.path, true), limit, check, discard);
    await copyFile(job.path, job.originalPath);
    return;
  }
  await pipeline(
    createReadStream(job.path, { highWaterMark: 1 << 20 }),
    check,
    createGzip(),
    createWriteStream(job.originalPath),
  );
}
