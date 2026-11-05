import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DuckDbSettingsError,
  checkDuckDbSettings,
  duckDbSettings,
} from './duckdb-settings.js';

describe('duckDbSettings', () => {
  it('defaults to 4GB, 4 threads and <OS temp>/ibero-duckdb', () => {
    expect(duckDbSettings({})).toEqual({
      memoryLimit: '4GB',
      threads: 4,
      tempDirectory: join(tmpdir(), 'ibero-duckdb'),
    });
  });

  it('reads DUCKDB_MEMORY_LIMIT, DUCKDB_THREADS and DUCKDB_TEMP_DIR', () => {
    expect(
      duckDbSettings({
        DUCKDB_MEMORY_LIMIT: ' 512MiB ',
        DUCKDB_THREADS: '2',
        DUCKDB_TEMP_DIR: 'storage/tmp',
      }),
    ).toEqual({
      memoryLimit: '512MiB',
      threads: 2,
      tempDirectory: resolve('storage/tmp'),
    });
  });

  it('rejects threads that are not a positive integer', () => {
    for (const value of ['0', '-2', '1.5', 'four']) {
      expect(() => duckDbSettings({ DUCKDB_THREADS: value })).toThrow(
        DuckDbSettingsError,
      );
    }
  });
});

describe('checkDuckDbSettings (real DuckDB)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duckdb-settings-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies the settings and creates the temp directory', async () => {
    const tempDirectory = join(dir, 'spill');
    const applied = await checkDuckDbSettings({
      memoryLimit: '1GB',
      threads: 2,
      tempDirectory,
    });
    expect(applied.threads).toBe(2);
    // DuckDB reports the limit in its own units (1GB → "953.6 MiB").
    expect(applied.memoryLimit).toMatch(/MiB|GiB/);
    expect(applied.tempDirectory).toBe(tempDirectory);
    expect((await stat(tempDirectory)).isDirectory()).toBe(true);
  });

  it('refuses a memory limit DuckDB does not understand', async () => {
    await expect(
      checkDuckDbSettings({
        memoryLimit: 'lots',
        threads: 1,
        tempDirectory: join(dir, 'x'),
      }),
    ).rejects.toThrow(
      /DuckDB rejected the settings \(DUCKDB_MEMORY_LIMIT="lots"/,
    );
  });
});
