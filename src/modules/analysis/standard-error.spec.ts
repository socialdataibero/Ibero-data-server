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
  return runOn(`SELECT * FROM read_csv('${fixture(csv)}', all_varchar = true)`, queries);
}

async function runOn(view: string, queries: RatioQuery[]) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE VIEW data AS ${view}`);
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

  describe('strata enumerated completely (certainty)', () => {
    // Stratum A is sampled (2 PSUs of weight 10); B is declared complete (COB = 1, weights 1 and 2);
    // C is not declared but every weight is 1. DOM puts A apart from B and C. By hand: Y = 14,
    // X = 46; in A the two PSUs differ by 10/46 in z, in B and in C by 1/46. Hence the error is
    // 10/46 with only A, and √(10² + 1 + 1) / 46 when every stratum counts.
    const rows: [string, string, number, string, string, string][] = [
      ['A', 'a1', 10, '1', '2', 'm'], ['A', 'a1', 10, '0', '2', 'm'], ['A', 'a2', 10, '0', '2', 'm'], ['A', 'a2', 10, '0', '2', 'm'],
      ['B', 'b1', 2, '1', '1', 'c'], ['B', 'b2', 1, '1', '1', 'c'], ['B', 'b2', 1, '0', '1', 'c'],
      ['C', 'c1', 1, '0', '2', 'c'], ['C', 'c2', 1, '1', '2', 'c'],
    ];
    const view = `SELECT * FROM (VALUES ${rows
      .map((r) => `(${r.map((v) => (typeof v === 'number' ? v : `'${v}'`)).join(', ')})`)
      .join(', ')}) AS t(EST, UPM, FAC, Y, COB, DOM)`;
    const query = (keys: string[], certainty: string | null): RatioQuery => ({
      source: 'data',
      keys,
      weight: 'FAC',
      stratum: 'EST',
      psu: 'UPM',
      y: `Y = '1'`,
      x: 'true',
      cases: `Y = '1'`,
      certainty,
    });

    it('a declared stratum, and one where every weight is 1, add nothing to the variance', async () => {
      const [declared, undeclared] = await runOn(view, [query([], `COB = '1'`), query([], null)]);
      expect(declared[0]).toMatchObject({ y: 14, x: 46 });
      expect(declared[0].se!.toFixed(6)).toBe((10 / 46).toFixed(6));
      // Without a declaration nothing is of certainty, not even C (the 2000 cases of the proposal).
      expect(undeclared[0].se!.toFixed(6)).toBe((Math.sqrt(102) / 46).toFixed(6));
    });

    it('a domain whose whole denominator is in certainty strata has no error, not 0', async () => {
      const [declared, undeclared] = await runOn(view, [query(['DOM'], `COB = '1'`), query(['DOM'], null)]);
      expect(declared.map((e) => [e.keys[0], e.y, e.x, e.se === null ? null : e.se.toFixed(6)])).toEqual([
        ['c', 4, 6, null],
        ['m', 10, 40, '0.250000'],
      ]);
      expect(undeclared.find((e) => e.keys[0] === 'c')!.se).not.toBeNull();
    });
  });

  it('refuses a stratum without a PSU', () => {
    expect(() =>
      ratioEstimatesSql({ source: 'data', keys: [], weight: null, stratum: 'ESTRATO', psu: null, y: '1', x: '1', cases: 'true' }),
    ).toThrow();
  });
});
