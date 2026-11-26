import { templateTable } from './template-table.js';
import type { ResultRow, TemplateResult } from './template-run.js';

const row = (over: Partial<ResultRow>): ResultRow => ({
  fuente: 'Censo', edicion: 2020, indicador: 'Habla lengua', criterio: null, nivel: 'entidad',
  cve: '01', nombre: 'Aguascalientes', grupo_codigo: null, grupo: null, corte_codigo: null,
  corte: null, desagregaciones: {}, num: 25, den: 200, den_total: null, ee: null, ee_total: null,
  casos: 10, es_total: true, ...over,
});

const result = (kind: 'proportion' | 'mean', rows: ResultRow[], breakdowns: TemplateResult['dimensions']['breakdowns'] = []) =>
  ({ value: { kind, label: '', unit: null }, dimensions: { group: null, series: null, breakdowns }, rows }) as unknown as TemplateResult;

describe('templateTable', () => {
  it('adds the percentage, drops empty columns and labels breakdowns', () => {
    const t = templateTable(result('proportion', [
      row({ desagregaciones: { SEXO: null } }),
      row({ desagregaciones: { SEXO: '2' }, num: 1, den: 3, es_total: false }),
      row({ desagregaciones: { SEXO: '2' }, num: 0, den: 0, es_total: false }),
    ], [{ column: 'SEXO', label: 'Sexo', categories: [{ code: '2', label: 'Mujer' }] }]));

    expect(t.columns).toEqual(['fuente', 'indicador', 'nivel', 'cve', 'nombre', 'edicion', 'desag_sexo_codigo', 'desag_sexo', 'porcentaje', 'num', 'den', 'casos', 'es_total']);
    expect(t.rows.map((r) => [r.desag_sexo_codigo, r.desag_sexo, r.porcentaje, r.es_total])).toEqual([
      ['*', 'Todos', 12.5, 'sí'], ['2', 'Mujer', 33.33, 'no'], ['2', 'Mujer', null, 'no'],
    ]);
    expect(t.types).toMatchObject({ porcentaje: 'DOUBLE', num: 'DOUBLE', casos: 'BIGINT' });
  });

  it('uses the mean as is, and the total base when there is one', () => {
    expect(templateTable(result('mean', [row({ num: 300, den: 4 })])).rows[0].promedio).toBe(75);
    const t = templateTable(result('proportion', [row({ den_total: 1000 })]));
    expect(t.rows[0]).toMatchObject({ porcentaje: 12.5, porcentaje_total: 2.5 });
    expect(templateTable(result('proportion', [row({ ee: 0.012 })])).rows[0].ee).toBeCloseTo(1.2);
  });
});
