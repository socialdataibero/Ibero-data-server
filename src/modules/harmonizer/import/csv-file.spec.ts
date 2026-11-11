import { DuckDBInstance } from '@duckdb/node-api';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCsvFile } from './csv-file.js';
import type { ImportError } from './import-error.js';

let dir: string;
const settings = () => ({
  memoryLimit: '512MB',
  threads: 1,
  tempDirectory: join(dir, 'duck'),
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csv-file-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function parquetRows(
  path: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_parquet('${path}')`,
    );
    return {
      columns: reader.columnNames(),
      rows: reader.getRowsJson() as unknown[][],
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function run(name: string, content: Buffer, gzip = false) {
  const path = join(dir, name);
  await writeFile(path, content);
  const job = {
    path,
    gzip,
    settings: settings(),
    parquetPath: join(dir, `${name}.parquet`),
    originalPath: join(dir, `${name}.original.csv.gz`),
  };
  return { job, result: importCsvFile(job) };
}

const CSV = '﻿FOLIO, EDAD ,EDAD\n001,"5"" pantalla",\n002,"a,b\nc",  7 \n';

describe('importCsvFile', () => {
  it('writes the raw Parquet (positional VARCHAR columns, values as read) and keeps the original', async () => {
    const { job, result } = await run('basic.csv', Buffer.from(CSV));
    const { header, rowCount } = await result;
    expect(header.columns).toEqual(['FOLIO', 'EDAD', 'EDAD.1']);
    expect(header.renamed).toEqual([
      { position: 3, original: 'EDAD', renamed: 'EDAD.1' },
    ]);
    expect(rowCount).toBe(2);
    expect(await parquetRows(job.parquetPath)).toEqual({
      columns: ['c0', 'c1', 'c2'],
      rows: [
        ['001', '5" pantalla', ''],
        ['002', 'a,b\nc', '  7 '],
      ],
    });
    expect(gunzipSync(await readFile(job.originalPath)).toString()).toBe(CSV);
  });

  it('reports progress phases', async () => {
    const path = join(dir, 'progress.csv');
    await writeFile(path, 'a\n1\n');
    const phases: string[] = [];
    await importCsvFile({
      path,
      gzip: false,
      settings: settings(),
      parquetPath: join(dir, 'progress.parquet'),
      originalPath: join(dir, 'progress.csv.gz'),
      onProgress: ({ phase }) => phases.push(phase),
    });
    expect(phases).toEqual(['checking', 'reading', 'saving']);
  });

  it('reads a .csv.gz and keeps it as it was uploaded', async () => {
    const gz = gzipSync(Buffer.from(CSV));
    const { job, result } = await run('basic.csv.gz', gz, true);
    expect((await result).rowCount).toBe(2);
    expect((await parquetRows(job.parquetPath)).rows[1]).toEqual([
      '002',
      'a,b\nc',
      '  7 ',
    ]);
    expect(await readFile(job.originalPath)).toEqual(gz);
  });

  it('rejects a broken .gz with gzip_invalid and leaves no files', async () => {
    const gz = gzipSync(Buffer.from(CSV)).subarray(0, 20);
    const { job, result } = await run('broken.csv.gz', gz, true);
    await expect(result).rejects.toMatchObject({
      code: 'gzip_invalid',
      statusCode: 400,
    });
    expect(await exists(job.parquetPath)).toBe(false);
    expect(await exists(job.originalPath)).toBe(false);
  });

  it('rejects a file that is not UTF-8 with its line, before reading rows', async () => {
    const latin1 = Buffer.concat([
      Buffer.from('a,b\n1,2\n"sin cerrar\nJos'),
      Buffer.from([0xe9]),
      Buffer.from('\n'),
    ]);
    const { job, result } = await run('latin1.csv', latin1);
    const err = (await result.catch((e: unknown) => e)) as ImportError;
    // The quote error on line 3 comes later: encoding is checked first, as in the synchronous upload.
    expect(err.toBody()).toMatchObject({
      code: 'csv_not_utf8',
      params: { line: 4 },
    });
    expect(await exists(job.parquetPath)).toBe(false);
    expect(await exists(job.originalPath)).toBe(false);
  });

  it('rejects CSV errors with the synchronous codes and leaves no files', async () => {
    const { job, result } = await run(
      'short.csv',
      Buffer.from('a,b\n1,2\n3\n'),
    );
    const err = (await result.catch((e: unknown) => e)) as ImportError;
    expect(err.toBody()).toMatchObject({
      code: 'csv_invalid',
      params: {
        problem: 'inconsistent_columns',
        line: 3,
        rowColumns: 1,
        headerColumns: 2,
      },
    });
    expect(await exists(job.parquetPath)).toBe(false);
    expect(await exists(job.originalPath)).toBe(false);

    const empty = await run('empty.csv', Buffer.alloc(0));
    await expect(empty.result).rejects.toMatchObject({ code: 'csv_empty' });
    const headerOnly = await run('header.csv', Buffer.from('a,b\n'));
    await expect(headerOnly.result).rejects.toMatchObject({
      code: 'csv_no_rows',
    });
  });
});
