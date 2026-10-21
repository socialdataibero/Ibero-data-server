import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalysisService } from './analysis.service.js';
import { stepsToInternal, type Step } from './recipe.js';

async function writeFixtureParquet(path: string, columns: string, values: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM (VALUES ${values}) AS t(${columns})) TO '${path.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
  }
}

describe('AnalysisService: join / merge entre recursos (DuckDB real)', () => {
  let dir: string;
  let peoplePath: string;
  let expansionPath: string;
  let service: AnalysisService;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-join-test-'));
    peoplePath = join(dir, 'people.parquet');
    expansionPath = join(dir, 'expansion.parquet');
    await writeFixtureParquet(
      peoplePath,
      'folio, municipio, ingreso',
      "(1, 'Centro', 1000.0::DOUBLE), (2, 'Centro', 2000.0::DOUBLE), (3, 'Norte', 3000.0::DOUBLE)",
    );
    await writeFixtureParquet(expansionPath, 'folio, factor', '(1, 4), (2, 2)');

    service = new AnalysisService();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function recipeFrom(steps: Step[]) {
    return stepsToInternal(steps);
  }

  it('INNER JOIN descarta las filas sin match en el otro resource', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
    ]);

    const result = await service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.folio).sort()).toEqual([1, 2]);
  });

  it('LEFT JOIN conserva las filas sin match, con NULL del lado derecho', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'left', onLeft: 'folio', onRight: 'folio' } },
    ]);

    const result = await service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]);

    expect(result.rows).toHaveLength(3);
    const folio3 = result.rows.find((r) => r.folio === 3);
    expect(folio3?.factor).toBeNull();
  });

  it('join + compute: aplica el factor de expansión de la fuente cruzada (caso real de la encuesta)', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
      { op: 'compute', params: { left: 'ingreso', right: 'factor', as: 'ingreso_ponderado' } },
    ]);

    const result = await service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]);

    const byFolio = Object.fromEntries(result.rows.map((r) => [r.folio, r.ingreso_ponderado]));
    expect(byFolio[1]).toBe(4000); // 1000 * 4
    expect(byFolio[2]).toBe(4000); // 2000 * 2
    expect(result.rows).toHaveLength(2); // folio 3 sigue sin aparecer (inner join)
  });

  it('join + group_by + aggregate: agrupa el resultado ya cruzado (equivalente a lo que hacía ckanext-duckdb)', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'left', onLeft: 'folio', onRight: 'folio' } },
      { op: 'compute', params: { left: 'ingreso', right: 'factor', as: 'ingreso_ponderado' } },
      { op: 'group_by', params: { columns: ['municipio'] } },
      { op: 'aggregate', params: { func: 'SUM', column: 'ingreso', as: 'total_ingreso' } },
    ]);

    const result = await service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]);

    const centro = result.rows.find((r) => r.municipio === 'Centro');
    const norte = result.rows.find((r) => r.municipio === 'Norte');
    expect(centro?.total_ingreso).toBe(3000); // 1000 + 2000
    expect(norte?.total_ingreso).toBe(3000); // solo folio 3
  });

  it('writeRecipeResult persiste un parquet con el join ya aplicado, legible después', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
    ]);
    const destPath = join(dir, 'result.parquet');

    await service.writeRecipeResult(peoplePath, recipe, destPath, [{ alias: 'expansion', path: expansionPath }]);
    const check = await service.runQuery(destPath, 'SELECT * FROM data ORDER BY folio');

    expect(check.rows).toHaveLength(2);
    expect(check.rows[0].factor).toBe(4);
  });

  it('columna inexistente en el join produce un BadRequestException con mensaje enmascarado (sin rutas de disco)', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'inner', onLeft: 'columna_que_no_existe', onRight: 'folio' } },
    ]);

    await expect(
      service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]),
    ).rejects.toMatchObject({ status: 400 });

    try {
      await service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]);
      throw new Error('no debería llegar aquí');
    } catch (err: any) {
      expect(err.message).not.toContain(dir);
    }
  });

  it('filtering a numeric column with text returns invalid_value without internal details (SDI-97)', async () => {
    const recipe = recipeFrom([{ op: 'filter', params: { column: 'folio', operator: '>', value: 'abc' } }]);

    await expect(service.runRecipe(peoplePath, recipe, null)).rejects.toMatchObject({
      response: {
        code: 'recipe_execution_failed',
        reason: 'invalid_value',
        message: 'The value "abc" is not a valid integer for this column.',
        params: { value: 'abc', expectedType: 'integer' },
      },
    });
  });

  it('a join on a missing column returns unknown_column with the column name (SDI-97)', async () => {
    const recipe = recipeFrom([
      { op: 'join', params: { resourceId: 'expansion', alias: 'expansion', type: 'inner', onLeft: 'no_such_column', onRight: 'folio' } },
    ]);

    await expect(
      service.runRecipe(peoplePath, recipe, null, [{ alias: 'expansion', path: expansionPath }]),
    ).rejects.toMatchObject({ response: { reason: 'unknown_column', params: { column: 'no_such_column' } } });
  });

  it.each<[string, string, Step[]]>([
    ['filter with a date on a number column', 'invalid_value', [{ op: 'filter', params: { column: 'ingreso', operator: '<', value: '2020-01-01' } }]],
    ['compute multiplying a text column', 'incompatible_types', [{ op: 'compute', params: { left: 'municipio', right: 2, as: 'x' } }]],
    ['aggregate summing a text column', 'incompatible_types', [
      { op: 'group_by', params: { columns: ['folio'] } },
      { op: 'aggregate', params: { func: 'SUM', column: 'municipio', as: 'total' } },
    ]],
    ['sort by a missing column', 'unknown_column', [{ op: 'sort', params: { column: 'no_such_column', dir: 'asc' } }]],
  ])('%s returns reason %s with an English message and no SQL (SDI-97)', async (_name, reason, steps) => {
    try {
      await service.runRecipe(peoplePath, recipeFrom(steps), null);
      throw new Error('should have failed');
    } catch (err: any) {
      expect(err.response.reason).toBe(reason);
      expect(err.response.message).not.toMatch(/SELECT|LINE \d|Error:|parquet/i);
    }
  });

  it('a SQL syntax error returns syntax_error without echoing the query (SDI-97)', async () => {
    await expect(service.runQuery(peoplePath, 'SELECT FROM WHERE data')).rejects.toMatchObject({
      response: { code: 'query_execution_failed', reason: 'syntax_error', message: 'The SQL query has a syntax error.' },
    });
  });
});

describe('AnalysisService: Parquet crudo del armonizador (DuckDB real)', () => {
  let dir: string;
  const service = new AnalysisService();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ibero-raw-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readParquetRows devuelve las filas tal como se escribieron, en orden y como texto', async () => {
    const path = join(dir, 'raw.parquet');
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      c0: String(i).padStart(5, '0'),
      c1: i % 2 === 0 ? 'Hñähñu' : '',
    }));

    await service.writeRowsToParquet(['c0', 'c1'], rows, path);
    const read = await service.readParquetRows(path);

    // Más filas que MAX_ROWS: la lectura cruda no se trunca.
    expect(read).toHaveLength(12_000);
    expect(read[0]).toEqual(['00000', 'Hñähñu']);
    expect(read[11_999]).toEqual(['11999', '']);
  });

  it('writeRowsToParquet escribe como número las columnas declaradas (sumables en un análisis)', async () => {
    const path = join(dir, 'typed.parquet');
    const rows = [
      { g: 'A', n: ' 2 ', f: '1.5', t: '01' },
      { g: 'A', n: '3', f: '1e1', t: null },
      { g: 'B', n: null, f: '-0.5', t: '02' },
    ];

    await service.writeRowsToParquet(['g', 'n', 'f', 't'], rows, path, {
      n: 'BIGINT',
      f: 'DOUBLE',
    });

    const schema = await service.describeSchema(path);
    expect(schema).toEqual([
      { name: 'g', type: 'VARCHAR' },
      { name: 'n', type: 'BIGINT' },
      { name: 'f', type: 'DOUBLE' },
      { name: 't', type: 'VARCHAR' },
    ]);
    const result = await service.runQuery(
      path,
      'SELECT g, SUM(n) AS n, SUM(n * f) AS nf FROM data GROUP BY g ORDER BY g',
    );
    expect(result.rows).toEqual([
      { g: 'A', n: '5', nf: 33 },
      { g: 'B', n: null, nf: null },
    ]);
  });
});
