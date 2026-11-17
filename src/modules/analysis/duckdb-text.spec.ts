import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisService } from './analysis.service.js';
import { jsTrimSql } from '../harmonizer/column-checks.js';
import { keepLeadingBomInDuckDbText } from './duckdb-text.js';

const BOM = '\ufeff';

// If this file fails after upgrading @duckdb/node-api, see duckdb-text.ts.
describe('text from DuckDB keeps a leading BOM (U+FEFF)', () => {
  let dir: string;
  let path: string;
  const service = new AnalysisService();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-bom-test-'));
    path = join(dir, 'bom.parquet');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT * FROM (VALUES ('1', 'a'), ('${BOM}1', 'b'), ('${BOM}1', '${BOM}'), ('x${BOM}', 'c')) AS t("${BOM}ID", v)) TO '${path}' (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is applied (the library still exports its decoder)', () => {
    expect(keepLeadingBomInDuckDbText()).toBe(true);
  });

  it('in values, as read by the paged views', async () => {
    const rows = await service.readParquetSlice(path, [`${BOM}ID`, 'v'], 0, 10);
    expect(rows).toEqual([
      ['1', 'a'],
      [`${BOM}1`, 'b'],
      [`${BOM}1`, BOM],
      [`x${BOM}`, 'c'],
    ]);
  });

  it('in value counts: with a trim that keeps it, "1" and BOM + "1" are two values', async () => {
    const spacesOnly = (e: string) => `coalesce(trim(${e}), '')`;
    const [counts] = await service.columnValueCounts(
      path,
      [`${BOM}ID`],
      10,
      spacesOnly,
    );
    expect(counts.values).toEqual([
      { value: `${BOM}1`, count: 2 },
      { value: '1', count: 1 },
      { value: `x${BOM}`, count: 1 },
    ]);
  });

  it("in value counts with the harmonizer's trim (JavaScript's), the BOM is trimmed like a space", async () => {
    const [id, v] = await service.columnValueCounts(
      path,
      [`${BOM}ID`, 'v'],
      10,
      jsTrimSql,
    );
    expect(id.values).toEqual([
      { value: '1', count: 3 },
      { value: 'x', count: 1 },
    ]);
    expect(v).toMatchObject({
      empty: 1,
      values: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
    });
  });

  it('in column names', async () => {
    const schema = await service.describeSchema(path);
    expect(schema.map((c) => c.name)).toEqual([`${BOM}ID`, 'v']);
    const result = await service.runQuery(
      path,
      `SELECT "${BOM}ID" FROM data LIMIT 1`,
    );
    expect(result.columns).toEqual([`${BOM}ID`]);
  });
});
