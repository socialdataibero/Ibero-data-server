import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalysisService } from '../analysis/analysis.service.js';
import { codebookMissingCodes, type CodebookCategory } from './codebook.js';
import {
  JS_WHITESPACE_CODES,
  allFit,
  columnTypeQuery,
  inferredType,
  mergeFacts,
  notFittingQuery,
  readColumnTypeResult,
  readNotFitting,
  readValueFacts,
  sqlString,
  valueFactsQuery,
  type ColumnTypeCheck,
  type ValueFactsCheck,
} from './column-checks.js';
import {
  inferValueType,
  sourceColumnValues,
  valuesNotFitting,
  type RawData,
  type ValueType,
} from './harmonized-view.js';

// Values that the JavaScript rules treat in different ways: whitespace JavaScript trims and
// DuckDB's trim does not, leading zeros, more than 15 digits, beyond BIGINT, beyond DOUBLE,
// number forms DuckDB reads but JavaScript does not (`1_000`, `0x10`, `inf`), non-ASCII digits.
const BATTERY = [
  '', '  ', '1', ' 2 ', '007', '-0', '+5', '-12', '1.5', '5.', '.5', '+.5e3', '1e5', '1E-3',
  '1e309', '-1e309', '1.7976931348623157e308', '1.7976931348623159e308', '1e-400',
  '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809',
  '123456789012345', '1234567890123456', '0123', '00.5', '0.5', '0', '000', '9', '09', '099',
  '99', '999', 'abc', 'NE', ' ne ', '1,5', '1_000', '0x10', 'inf', 'NaN', 'Infinity', '٣',
  '１２', ' 12 ', '\t3\n', '　7　', '﻿8', ' 4 ', '​5',
  "it's", 'é', '+', '-', '.', 'e5', '1e', '--1', '+-1',
];

/** Deterministic pseudo-random numbers, so a failure can be repeated. */
function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const COLUMNS = 40;
const ROWS = 300;

function buildRows(): string[][] {
  const rand = prng(42);
  const rows: string[][] = [];
  // Each column draws from its own small subset of the battery, so many columns end up
  // integer-only, decimal-only, text, or empty.
  const subsets = Array.from({ length: COLUMNS }, (_, c) => {
    if (c === 0) return BATTERY;
    if (c === 1) return [''];
    if (c === 2) return ['1', '2', '3', '99', ''];
    if (c === 3) return ['1.5', '2', ' 3 ', '999', ''];
    const size = 1 + Math.floor(rand() * 6);
    return Array.from({ length: size }, () => BATTERY[Math.floor(rand() * BATTERY.length)]);
  });
  for (let r = 0; r < ROWS; r++) {
    rows.push(
      subsets.map((subset, c) =>
        c === 0 && r < BATTERY.length ? BATTERY[r] : subset[Math.floor(rand() * subset.length)],
      ),
    );
  }
  return rows;
}

describe('column-checks: DuckDB gives what the JavaScript rules give', () => {
  let dir: string;
  let path: string;
  let rows: string[][];
  let raw: RawData[];
  const service = new AnalysisService();
  const name = (c: number) => `col${c}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-column-checks-'));
    path = join(dir, 'raw.parquet');
    rows = buildRows();
    raw = rows.map((r) => Object.fromEntries(r.map((v, c) => [name(c), v])));
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const columns = Array.from({ length: COLUMNS }, (_, c) => `c${c}`).join(', ');
      const values = rows.map((r) => `(${r.map(sqlString).join(', ')})`).join(', ');
      await connection.run(
        `COPY (SELECT * FROM (VALUES ${values}) AS t(${columns})) TO ${sqlString(path)} (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trims exactly what String.prototype.trim trims', () => {
    const expected: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (String.fromCharCode(code).trim() === '') expected.push(code);
    }
    expect([...JS_WHITESPACE_CODES].sort((a, b) => a - b)).toEqual(expected);
  });

  const codeSets: string[][] = [[], ['99'], ['999', 'NE'], ['9', '1.5', 'abc'], ['1e309', '0123', '-0']];

  it('suggested type and "all fit", with and without missing codes', async () => {
    const checks: ColumnTypeCheck[] = [];
    for (let c = 0; c < COLUMNS; c++) {
      for (const codes of codeSets) {
        checks.push({ rawColumn: `c${c}`, missingCodes: codes, codebookMissing: null });
      }
    }
    const results = await service.runInternalQueries(path, checks.map(columnTypeQuery));
    checks.forEach((check, i) => {
      const column = name(Number(check.rawColumn.slice(1)));
      const values = sourceColumnValues(raw, column, new Set(check.missingCodes));
      const facts = readColumnTypeResult(check, results[i][0]).saved;
      const where = `${column} without ${JSON.stringify(check.missingCodes)}`;
      expect(inferredType(facts), where).toBe(inferValueType(values));
      for (const type of ['integer', 'decimal', 'text'] as ValueType[]) {
        expect(allFit(facts, type), `${where} ${type}`).toBe(
          valuesNotFitting(values, type, 1).length === 0,
        );
      }
    });
  });

  it('dictionary codes of «No especificado» and the type without them', async () => {
    const category = (code: string): CodebookCategory =>
      ({ code, label: 'No especificado', kind: 'missing' }) as CodebookCategory;
    const codebookSets: string[][] = [[], ['9'], ['99', '999'], ['NE', '0'], ['0009', 'abc', '']];
    const checks: ColumnTypeCheck[] = [];
    for (let c = 0; c < COLUMNS; c++) {
      for (const codes of codebookSets) {
        checks.push({ rawColumn: `c${c}`, missingCodes: [], codebookMissing: codes });
      }
    }
    const results = await service.runInternalQueries(path, checks.map(columnTypeQuery));
    checks.forEach((check, i) => {
      const column = name(Number(check.rawColumn.slice(1)));
      const categories = check.codebookMissing!.map(category);
      // What getMapping did: every distinct trimmed value of the column.
      const distinct = new Set(raw.map((r) => (r[column] ?? '').trim()));
      distinct.delete('');
      const expectedCodes = codebookMissingCodes(categories, distinct);
      const result = readColumnTypeResult(check, results[i][0]).codebook!;
      const where = `${column} with dictionary ${JSON.stringify(check.codebookMissing)}`;
      expect(codebookMissingCodes(categories, result.codeValues), where).toEqual(expectedCodes);

      const values = sourceColumnValues(raw, column, new Set(expectedCodes));
      expect(inferredType(result.facts), where).toBe(inferValueType(values));
      for (const type of ['integer', 'decimal'] as ValueType[]) {
        expect(allFit(result.facts, type), `${where} ${type}`).toBe(
          valuesNotFitting(values, type, 1).length === 0,
        );
      }
    });
  });

  it('values that do not fit, in order of appearance, with codes and recoding', async () => {
    const maps: (Map<string, string> | undefined)[] = [
      undefined,
      new Map([['abc', '1'], ['1.5', 'x'], ['NE', '99']]),
      new Map([['1e309', '5'], ['٣', '3'], ['0x10', "16'"]]),
    ];
    const checks = [];
    for (let c = 0; c < COLUMNS; c++) {
      for (const codes of codeSets) {
        for (const valueMap of maps) {
          for (const type of ['integer', 'decimal'] as ValueType[]) {
            for (const limit of [1, 5]) {
              checks.push({ rawColumn: `c${c}`, type, missingCodes: codes, valueMap, limit });
            }
          }
        }
      }
    }
    const results = await service.runInternalQueries(path, checks.map(notFittingQuery));
    checks.forEach((check, i) => {
      const column = name(Number(check.rawColumn.slice(1)));
      const expected = valuesNotFitting(
        sourceColumnValues(raw, column, new Set(check.missingCodes), check.valueMap),
        check.type,
        check.limit,
      );
      expect(readNotFitting(results[i]), `${column} ${JSON.stringify(check)}`).toEqual(expected);
    });
  });

  it('suggested type of the exported values (codes and recoding), alone and put together', async () => {
    const maps = [
      new Map<string, string>(),
      new Map([['abc', '1'], ['1.5', 'x'], ['NE', '99']]),
      new Map([['1e309', '5'], ['٣', '3'], ['0x10', ' 16 '], ['007', '7'], ['9', '']]),
    ];
    const checks: ValueFactsCheck[] = [];
    for (let c = 0; c < COLUMNS; c++) {
      for (const codes of codeSets) {
        for (const valueMap of maps) {
          checks.push({ rawColumn: `c${c}`, missingCodes: codes, valueMap });
        }
      }
    }
    const results = await service.runInternalQueries(path, checks.map(valueFactsQuery));
    const valuesOf = (i: number) => {
      const check = checks[i];
      const column = name(Number(check.rawColumn.slice(1)));
      return sourceColumnValues(raw, column, new Set(check.missingCodes), check.valueMap);
    };
    const facts = results.map((r) => readValueFacts(r[0]));
    checks.forEach((check, i) => {
      expect(inferredType(facts[i]), JSON.stringify([...Object.entries(check), [...check.valueMap]])).toBe(
        inferValueType(valuesOf(i)),
      );
    });
    // Several editions in one export: the type of all their values together.
    for (let i = 0; i + 2 < checks.length; i += 7) {
      const group = [i, i + 1, i + 2];
      expect(inferredType(mergeFacts(group.map((g) => facts[g]))), `checks ${group}`).toBe(
        inferValueType(group.flatMap(valuesOf)),
      );
    }
  });
});
