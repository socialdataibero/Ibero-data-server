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
});
