import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { stringify } from 'csv-stringify/sync';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalysisService, type ParquetColumnType } from '../analysis/analysis.service.js';
import { sqlString } from './column-checks.js';
import {
  editionCsvLinesSql,
  editionParquetSql,
  editionSelectSql,
  exportColumns,
  originalCsvLinesSql,
  originalSelectSql,
  surveyParquetSql,
  type ExportColumn,
} from './harmonized-export.js';
import {
  buildDatasetView,
  buildSurveyView,
  neutralizeCsvFormula,
  type DatasetEdition,
  type RawData,
} from './harmonized-view.js';

// Values the view treats in different ways: empty, whitespace JavaScript trims and DuckDB's trim
// does not, missing codes with spaces around, recoded values, quotes, line breaks, NULL cells.
const VALUES = [
  '', ' ', '\t', '　', '﻿', '1', ' 2 ', '99', ' 99 ', '9', '007', 'H', ' M ', 'Si', 'No',
  "O'Brien", 'a"b', 'x\ny', 'é', '=1+1', '100 y mas', '1.5', ' 3 ', null,
  // CSV quoting and formula neutralization (H-12).
  'a,b', '\r', 'x\r\ny', '"', '""', '-1+1', '@SUM(1)', '+3.2', '-5', '1e-3', '\tx', ' =x', '﻿=x',
];

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

interface Mapping {
  sourceColumn: string;
  canon: string;
  missingCodes: string[];
  valueMap: Map<string, string>;
}

interface Edition {
  name: string;
  year: number;
  columns: string[];
  mappings: Mapping[];
  rows: (string | null)[][];
  path: string;
}

/** The edition as `toEdition` builds it from the stored rows (a NULL cell reads as `''`). */
function jsEdition(e: Edition): DatasetEdition {
  return {
    name: e.name,
    year: e.year,
    columns: e.columns,
    columnToCanonical: new Map(e.mappings.map((m) => [m.sourceColumn, m.canon])),
    missingCodes: new Map(e.mappings.map((m) => [m.sourceColumn, new Set(m.missingCodes)])),
    valueMaps: new Map(e.mappings.map((m) => [m.sourceColumn, m.valueMap])),
    rows: e.rows.map(
      (r): RawData => Object.fromEntries(e.columns.map((c, i) => [c, String(r[i] ?? '')])),
    ),
  };
}

function columnsOf(e: Edition): ExportColumn[] {
  return exportColumns(e.columns, e.mappings);
}

describe('harmonized-export: DuckDB gives what the harmonized view gives', () => {
  const service = new AnalysisService({ threads: '4' });
  let dir: string;
  let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
  const editions: Edition[] = [];

  async function writeRaw(path: string, width: number, rows: (string | null)[][]) {
    const names = Array.from({ length: width }, (_, c) => `c${c}`);
    const tuples = rows.map((r) => `(${r.map((v) => (v === null ? 'NULL::VARCHAR' : sqlString(v))).join(', ')})`);
    await connection.run(`CREATE OR REPLACE TABLE raw (${names.map((n) => `${n} VARCHAR`).join(', ')})`);
    for (let i = 0; i < tuples.length; i += 1000) {
      await connection.run(`INSERT INTO raw VALUES ${tuples.slice(i, i + 1000).join(', ')}`);
    }
    await connection.run(`COPY raw TO ${sqlString(path)} (FORMAT PARQUET, ROW_GROUP_SIZE 2048)`);
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-harmonized-export-'));
    connection = await (await DuckDBInstance.create(':memory:')).connect();
    const rand = prng(7);
    const pick = (from: (string | null)[]) => from[Math.floor(rand() * from.length)];
    const numbers = ['1', ' 2 ', '99', '', '30', '-4'];
    const decimals = ['1.5', ' .5 ', '2', '', '1e3'];
    // Repeated `B` (an edition from before headers were deduplicated) and two columns mapped to
    // `x` (A and E): the last column wins, at the position of the first.
    const specs = [
      {
        name: 'e2015',
        year: 2015,
        columns: ['A', 'B', 'B', 'C', 'D', 'E', 'N', 'F'],
        mappings: [
          { sourceColumn: 'A', canon: 'x', missingCodes: ['99'], valueMap: new Map() },
          { sourceColumn: 'B', canon: 'y', missingCodes: [], valueMap: new Map([['H', '1'], ['M', '2']]) },
          { sourceColumn: 'C', canon: 'z', missingCodes: ['9', '99'], valueMap: new Map([['Si', '1'], ['100 y mas', '100'], ['No', ' 2 ']]) },
          { sourceColumn: 'E', canon: 'x', missingCodes: [], valueMap: new Map([["O'Brien", 'ob']]) },
          { sourceColumn: 'N', canon: 'num', missingCodes: ['99'], valueMap: new Map() },
          { sourceColumn: 'F', canon: 'dec', missingCodes: [], valueMap: new Map() },
        ],
        rows: 25_000,
      },
      {
        name: "e2020 'b'",
        year: 2020,
        columns: ['C', 'N', 'G', 'F'],
        mappings: [
          { sourceColumn: 'C', canon: 'z', missingCodes: [], valueMap: new Map() },
          { sourceColumn: 'N', canon: 'num', missingCodes: [], valueMap: new Map([['99', '0']]) },
          { sourceColumn: 'G', canon: 'solo2020', missingCodes: [], valueMap: new Map() },
          { sourceColumn: 'F', canon: 'dec', missingCodes: ['1e3'], valueMap: new Map() },
        ],
        rows: 30_000,
      },
      // None of its variables is chosen in the survey export below: it gives no rows there.
      {
        name: 'e2020 otra',
        year: 2020,
        columns: ['Q'],
        mappings: [{ sourceColumn: 'Q', canon: 'otra', missingCodes: [], valueMap: new Map() }],
        rows: 10,
      },
    ];
    for (const [n, spec] of specs.entries()) {
      const rows = Array.from({ length: spec.rows }, () =>
        spec.columns.map((c) => (c === 'N' ? pick(numbers) : c === 'F' ? pick(decimals) : pick(VALUES))),
      );
      const path = join(dir, `e${n}.parquet`);
      await writeRaw(path, spec.columns.length, rows);
      editions.push({ ...spec, rows, path });
    }
  });

  afterAll(async () => {
    connection.closeSync();
    await rm(dir, { recursive: true, force: true });
  });

  async function selectRows(e: Edition, columns: ExportColumn[]) {
    const names = columns.map((c) => c.canon);
    const out: unknown[][] = [];
    for await (const chunk of service.streamInternalRows(e.path, editionSelectSql('data', columns, names))) {
      out.push(...chunk);
    }
    return out;
  }

  it('edition: same columns, values and order (codes, recoding, NULL cells, repeated headers)', async () => {
    for (const e of editions) {
      const expected = buildDatasetView(jsEdition(e));
      const columns = columnsOf(e);
      expect(columns.map((c) => c.canon), e.name).toEqual(expected.headers);
      const rows = await selectRows(e, columns);
      expect(rows.map((r) => Number(r[0])), e.name).toEqual(rows.map((_, i) => i));
      expect(
        rows.map((r) => Object.fromEntries(expected.headers.map((h, i) => [h, r[i + 1]]))),
        e.name,
      ).toEqual(expected.rows);
    }
  });

  it('original: every column as stored, NULL as empty, a repeated header gives its last column', async () => {
    for (const e of editions) {
      // What the download did: each stored row as an object by header name, then the values
      // of the headers in order.
      const expected = jsEdition(e).rows.map((row) => e.columns.map((c) => row[c]));
      const rows: unknown[][] = [];
      for await (const chunk of service.streamInternalRows(e.path, originalSelectSql(e.columns))) {
        rows.push(...chunk);
      }
      expect(rows, e.name).toEqual(expected);
    }
  });

  /** The Parquet the old code wrote (`writeRowsToParquet` over the view) and the new one. */
  async function expectSameParquet(oldPath: string, newPath: string) {
    const schema = async (p: string) =>
      (await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlString(p)})`)).getRowsJson().map((r) => [r[0], r[1]]);
    expect(await schema(newPath)).toEqual(await schema(oldPath));
    const src = (p: string) => `SELECT * FROM read_parquet(${sqlString(p)}, file_row_number = true)`;
    const count = async (sql: string) => Number((await connection.runAndReadAll(`SELECT count(*) FROM (${sql})`)).getRowsJson()[0][0]);
    expect(await count(src(newPath))).toBe(await count(src(oldPath)));
    expect(await count(`${src(oldPath)} EXCEPT ALL ${src(newPath)}`)).toBe(0);
    expect(await count(`${src(newPath)} EXCEPT ALL ${src(oldPath)}`)).toBe(0);
  }

  it('edition Parquet: same as writing the view with the same types', async () => {
    const e = editions[0];
    const view = buildDatasetView(jsEdition(e));
    const types: Record<string, ParquetColumnType> = { num: 'BIGINT', dec: 'DOUBLE' };
    const oldPath = join(dir, 'edition-old.parquet');
    const newPath = join(dir, 'edition-new.parquet');
    await service.writeRowsToParquet(view.headers, view.rows, oldPath, types);
    await service.copyInternalQueryToParquet(
      [{ alias: 'e0', path: e.path }],
      [editionParquetSql('e0', columnsOf(e), types)],
      newPath,
    );
    await expectSameParquet(oldPath, newPath);
  });

  it('typed values are trimmed like the type checks: a BOM, a tab or a no-break space around a number', async () => {
    // The type checks (jsTrimSql) accept these as numbers; DuckDB's TRIM alone did not, and the
    // Parquet export failed with parquet_write_failed.
    const path = join(dir, 'whitespace.parquet');
    await writeRaw(path, 2, [
      ['\ufeff1', '\ufeff1.5'],
      ['1\t', '\t2.5'],
      [' 2 ', '\u00a03'],
      ['\u00a0', '\ufeff'],
      [null, null],
    ]);
    const columns: ExportColumn[] = [
      { canon: 'num', rawColumn: 'c0', missingCodes: [], valueMap: new Map() },
      { canon: 'dec', rawColumn: 'c1', missingCodes: [], valueMap: new Map() },
    ];
    const sql = editionSelectSql('data', columns, ['num', 'dec'], { num: 'BIGINT', dec: 'DOUBLE' });
    const rows: unknown[][] = [];
    for await (const chunk of service.streamInternalRows(path, sql)) rows.push(...chunk);
    expect(rows.map((r) => r.slice(1))).toEqual([
      ['1', 1.5],
      ['1', 2.5],
      ['2', 3],
      [null, null],
      [null, null],
    ]);
  });

  it('survey Parquet: editions stacked in order, absent variables NULL, same types', async () => {
    const wanted = ['dec', 'num', 'solo2020', 'x', 'z'];
    const view = buildSurveyView(editions.map(jsEdition), wanted);
    const types: Record<string, ParquetColumnType> = {
      _dataset: 'VARCHAR',
      _year: 'BIGINT',
      _row: 'BIGINT',
      num: 'BIGINT',
      dec: 'DOUBLE',
    };
    const oldPath = join(dir, 'survey-old.parquet');
    const newPath = join(dir, 'survey-new.parquet');
    await service.writeRowsToParquet(['_dataset', '_year', '_row', ...wanted], view.rows, oldPath, types);
    const wantedSet = new Set(wanted);
    const included = editions
      .map((e, n) => ({ e, n, columns: columnsOf(e).filter((c) => wantedSet.has(c.canon)) }))
      .filter((i) => i.columns.length > 0);
    expect(included.map((i) => i.e.name)).toEqual(['e2015', "e2020 'b'"]);
    await service.copyInternalQueryToParquet(
      included.map((i) => ({ alias: `e${i.n}`, path: i.e.path })),
      surveyParquetSql(
        included.map((i) => ({ source: `e${i.n}`, name: i.e.name, year: i.e.year, columns: i.columns })),
        wanted,
        types,
      ),
      newPath,
    );
    await expectSameParquet(oldPath, newPath);
  });

  it('survey Parquet with many editions keeps their order', async () => {
    // The first two editions, twelve times over, written one after another.
    const many = Array.from({ length: 12 }, (_, k) => ({ ...editions[k % 2], name: `ed${k}` }));
    const wanted = ['num', 'z'];
    const types: Record<string, ParquetColumnType> = {
      _dataset: 'VARCHAR',
      _year: 'BIGINT',
      _row: 'BIGINT',
      num: 'BIGINT',
    };
    const view = buildSurveyView(many.map(jsEdition), wanted);
    const oldPath = join(dir, 'many-old.parquet');
    const newPath = join(dir, 'many-new.parquet');
    await service.writeRowsToParquet(['_dataset', '_year', '_row', ...wanted], view.rows, oldPath, types);
    await service.copyInternalQueryToParquet(
      many.map((e, n) => ({ alias: `e${n}`, path: e.path })),
      surveyParquetSql(
        many.map((e, n) => ({
          source: `e${n}`,
          name: e.name,
          year: e.year,
          columns: columnsOf(e).filter((c) => wanted.includes(c.canon)),
        })),
        wanted,
        types,
      ),
      newPath,
    );
    await expectSameParquet(oldPath, newPath);
  });

  it('survey Parquet with no variables: the three origin columns and no rows', async () => {
    const types: Record<string, ParquetColumnType> = { _dataset: 'VARCHAR', _year: 'BIGINT', _row: 'BIGINT' };
    const oldPath = join(dir, 'empty-old.parquet');
    const newPath = join(dir, 'empty-new.parquet');
    await service.writeRowsToParquet(['_dataset', '_year', '_row'], [], oldPath, types);
    await service.copyInternalQueryToParquet([], surveyParquetSql([], [], types), newPath);
    await expectSameParquet(oldPath, newPath);
  });

  // What the CSV downloads wrote before B5: csv-stringify over the view's rows, with a BOM.
  const csvOptions = (columns: string[]) => ({
    header: true,
    columns: columns.map((key) => ({ key, header: neutralizeCsvFormula(key) })),
    cast: { number: (n: number) => String(n), string: neutralizeCsvFormula },
  });

  async function writeLines(sources: { alias: string; path: string }[], parts: string[], prefix: string) {
    const out = join(dir, `lines-${Math.random().toString(36).slice(2)}.csv`);
    await service.writeInternalLines(sources, parts, out, prefix);
    return readFile(out, 'utf8');
  }

  it('edition CSV: the same bytes as csv-stringify (quotes, formulas, line breaks)', async () => {
    for (const e of editions) {
      const view = buildDatasetView(jsEdition(e));
      const expected = `\ufeff${stringify(view.rows, csvOptions(view.headers))}`;
      const actual = await writeLines(
        [{ alias: 'e0', path: e.path }],
        [editionCsvLinesSql('e0', columnsOf(e), view.headers)],
        `\ufeff${stringify([], csvOptions(view.headers))}`,
      );
      expect(actual === expected, e.name).toBe(true);
    }
  });

  it('survey CSV: editions in order, origin columns, absent variables empty, odd edition names', async () => {
    const named = ['=ed,1', 'ed "2"', '-3', ...Array.from({ length: 9 }, (_, k) => `ed${k}`)];
    const many = named.map((name, k) => ({ ...editions[k % 3], name }));
    const wanted = ['dec', 'num', 'otra', 'solo2020', 'x', 'y', 'z'];
    const view = buildSurveyView(many.map(jsEdition), wanted);
    const columns = ['_dataset', '_year', '_row', ...wanted];
    const expected = `\ufeff${stringify(view.rows, csvOptions(columns))}`;
    const included = many
      .map((e, n) => ({ e, n, columns: columnsOf(e).filter((c) => wanted.includes(c.canon)) }))
      .filter((i) => i.columns.length > 0);
    const actual = await writeLines(
      included.map((i) => ({ alias: `e${i.n}`, path: i.e.path })),
      included.map((i) =>
        editionCsvLinesSql(`e${i.n}`, i.columns, wanted, { name: i.e.name, year: i.e.year }),
      ),
      `\ufeff${stringify([], csvOptions(columns))}`,
    );
    expect(actual.length).toBe(expected.length);
    expect(actual === expected).toBe(true);
  });

  it('original CSV: the same bytes as csv-stringify over the stored rows', async () => {
    for (const e of editions) {
      const rows = jsEdition(e).rows.map((row) => e.columns.map((c) => row[c]));
      const expected = `\ufeff${stringify([e.columns, ...rows])}`;
      const actual = await writeLines(
        [{ alias: 'e0', path: e.path }],
        [originalCsvLinesSql('e0', e.columns)],
        `\ufeff${stringify([e.columns])}`,
      );
      expect(actual === expected, e.name).toBe(true);
    }
  });

  it('CSV of a file with 600 columns (one line per row, not too deep for DuckDB)', async () => {
    const width = 600;
    const columns = Array.from({ length: width }, (_, c) => `C${c}`);
    const rows = Array.from({ length: 5 }, (_, r) => columns.map((_, c) => VALUES[(r * 7 + c) % VALUES.length]));
    const path = join(dir, 'wide.parquet');
    await writeRaw(path, width, rows);
    const e: Edition = {
      name: 'ancho',
      year: 2020,
      columns,
      mappings: columns.map((c, i) => ({
        sourceColumn: c,
        canon: `v${i}`,
        missingCodes: [],
        valueMap: new Map<string, string>(),
      })),
      rows,
      path,
    };
    const view = buildDatasetView(jsEdition(e));
    expect(
      await writeLines(
        [{ alias: 'e0', path }],
        [editionCsvLinesSql('e0', columnsOf(e), view.headers)],
        `\ufeff${stringify([], csvOptions(view.headers))}`,
      ),
    ).toBe(`\ufeff${stringify(view.rows, csvOptions(view.headers))}`);
    const stored = jsEdition(e).rows.map((row) => columns.map((c) => row[c]));
    expect(
      await writeLines([{ alias: 'e0', path }], [originalCsvLinesSql('e0', columns)], `\ufeff${stringify([columns])}`),
    ).toBe(`\ufeff${stringify([columns, ...stored])}`);
  });
});
