import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalysisService } from './analysis.service.js';

// Two DuckDBs spilling to disk in the same folder at once overwrite each other's files
// ("Could not read enough bytes from file …duckdb_temp_storage…", seen with three queries over
// the census). Each DuckDB the service opens gets its own folder inside the configured one.
describe('AnalysisService temp directory', () => {
  let dir: string;
  let parquet: string;
  let temp: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-duckdb-temp-'));
    parquet = join(dir, 'small.parquet');
    temp = join(dir, 'spill');
    await mkdir(temp);
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT i::VARCHAR AS c0 FROM range(10) t(i)) TO '${parquet}' (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives each DuckDB its own folder inside temp_directory and removes it', async () => {
    const service = new AnalysisService({
      memory_limit: '1GB',
      threads: '1',
      temp_directory: temp,
    });
    const query = "SELECT current_setting('temp_directory'), count(*)::INTEGER FROM data";
    const results = await Promise.all(
      [1, 2, 3].map(() => service.runInternalQueries(parquet, [query])),
    );
    const folders = results.map(([rows]) => String(rows[0][0]));
    for (const folder of folders) expect(dirname(folder)).toBe(temp);
    expect(new Set(folders).size).toBe(3);
    for (const [rows] of results) expect(rows[0][1]).toBe(10);
    expect(await readdir(temp)).toEqual([]);
  });
});
