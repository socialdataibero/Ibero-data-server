import { DuckDBInstance } from '@duckdb/node-api';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ratioEstimatesSql, readRatioEstimates, type RatioQuery } from './standard-error.js';

/**
 * Checked against the synthetic validation cases of the template proposal (annex B): their
 * expected results were computed separately in Polars (`proporcion_v1_esperado.csv`,
 * `promedio_ponderado_v1_esperado.csv`), rounded to 6 decimals.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/templates/${name}`, import.meta.url));

async function run(csv: string, queries: RatioQuery[]) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(
      `CREATE VIEW data AS SELECT * FROM read_csv('${fixture(csv)}', all_varchar = true)`,
    );
    const out = [];
    for (const q of queries) {
      const rows = (await connection.runAndReadAll(ratioEstimatesSql(q))).getRowsJson() as unknown[][];
      out.push(readRatioEstimates(q, rows));
    }
    return out;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const design = { weight: 'FACTOR', stratum: 'ESTRATO', psu: 'UPM', source: 'data' };

describe('ratioEstimatesSql', () => {
  it('a proportion by entity and its total row (proporcion_v1, excluding "not specified")', async () => {
    const proportion = (keys: string[]): RatioQuery => ({
      ...design,
      keys,
      y: `HLI = '1'`,
      x: `HLI IS NOT NULL AND HLI <> '9'`,
      cases: `HLI = '1'`,
    });
    const [byEntity, total] = await run('proporcion_v1_entrada.csv', [proportion(['ENT']), proportion([])]);
    expect(byEntity.map((e) => [e.keys[0], e.y, e.x, e.cases])).toEqual([
      ['01', 40, 70, 3],
      ['02', 110, 210, 3],
      ['03', 0, 40, 0],
    ]);
    expect(byEntity.map((e) => e.se!.toFixed(6))).toEqual(['0.081633', '0.163265', '0.000000']);
    expect(total[0]).toMatchObject({ keys: ['*'], y: 150, x: 320, cases: 6 });
    expect(total[0].se!.toFixed(6)).toBe('0.114199');
  });

  it('including "not specified" only changes the denominator', async () => {
    const [byEntity, total] = await run(
      'proporcion_v1_entrada.csv',
      [['ENT'], []].map((keys) => ({ ...design, keys, y: `HLI = '1'`, x: `HLI IS NOT NULL`, cases: `HLI = '1'` })),
    );
    expect(byEntity.map((e) => [e.y, e.x, e.se!.toFixed(6)])).toEqual([
      [40, 90, '0.148148'],
      [110, 240, '0.208333'],
      [0, 65, '0.000000'],
    ]);
    expect([total[0].x, total[0].se!.toFixed(6)]).toEqual([395, '0.134116']);
  });

  it('a weighted mean is a ratio too: its error is in the units of the measure', async () => {
    const valid = `EDAD IS NOT NULL AND EDAD <> '999'`;
    const mean = (keys: string[]): RatioQuery => ({
      ...design,
      keys,
      y: `CASE WHEN ${valid} THEN CAST(EDAD AS DOUBLE) ELSE 0 END`,
      x: valid,
      cases: valid,
    });
    const [byEntity, total] = await run('promedio_ponderado_v1_entrada.csv', [mean(['ENT']), mean([])]);
    expect(byEntity.map((e) => [e.y, e.x, e.cases, e.se!.toFixed(6)])).toEqual([
      [2790, 110, 7, '0.165289'],
      [7640, 280, 8, '8.326531'],
      [2805, 80, 4, '18.046875'],
    ]);
    expect([total[0].y, total[0].x, total[0].se!.toFixed(6)]).toEqual([13235, 470, '6.065451']);
  });

  it('without a stratum and a PSU the error is null, not 0', async () => {
    const [rows] = await run('proporcion_v1_entrada.csv', [
      { source: 'data', keys: ['ENT'], weight: null, stratum: null, psu: null, y: `HLI = '1'`, x: 'true', cases: `HLI = '1'` },
    ]);
    expect(rows.map((r) => [r.keys[0], r.y, r.se])).toEqual([
      ['01', 3, null],
      ['02', 3, null],
      ['03', 0, null],
    ]);
  });

  it('a domain with nobody in the universe has no error', async () => {
    const [rows] = await run('proporcion_v1_entrada.csv', [
      { ...design, keys: ['ENT'], y: `HLI = '1'`, x: `ENT = '01'`, cases: `HLI = '1'` },
    ]);
    expect(rows.find((r) => r.keys[0] === '02')).toMatchObject({ x: 0, se: null });
  });

  it('refuses a stratum without a PSU', () => {
    expect(() =>
      ratioEstimatesSql({ source: 'data', keys: [], weight: null, stratum: 'ESTRATO', psu: null, y: '1', x: '1', cases: 'true' }),
    ).toThrow();
  });
});
