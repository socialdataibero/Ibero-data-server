import {
  buildDatasetView,
  buildSurveyView,
  type DatasetEdition,
} from './harmonized-view.js';

function edition(
  partial: Partial<DatasetEdition> & Pick<DatasetEdition, 'columns' | 'rows'>,
): DatasetEdition {
  return {
    name: partial.name ?? 'ds',
    year: partial.year ?? 2020,
    columns: partial.columns,
    columnToCanonical: partial.columnToCanonical ?? new Map(),
    missingCodes: partial.missingCodes,
    rows: partial.rows,
  };
}

describe('harmonizer: buildDatasetView', () => {
  it('sin mapeos devuelve headers y rows vacíos', () => {
    const view = buildDatasetView(
      edition({ columns: ['a'], rows: [{ a: '1' }] }),
    );
    expect(view).toEqual({ headers: [], rows: [] });
  });

  it('proyecta solo columnas mapeadas, renombradas, en el orden del CSV', () => {
    const view = buildDatasetView(
      edition({
        columns: ['folio', 'age', 'sexo', 'extra'],
        columnToCanonical: new Map([
          ['sexo', 'sexo'],
          ['age', 'edad'],
        ]),
        rows: [
          { folio: '1', age: '30', sexo: 'M', extra: 'x' },
          { folio: '2', age: '', sexo: 'F', extra: 'y' },
        ],
      }),
    );
    expect(view.headers).toEqual(['edad', 'sexo']);
    expect(view.rows).toEqual([
      { edad: '30', sexo: 'M' },
      { edad: null, sexo: 'F' },
    ]);
  });

  it('vacío, solo espacios y códigos de no especificado salen como null; el cero se conserva', () => {
    const view = buildDatasetView(
      edition({
        columns: ['EDAD', 'NIVACAD'],
        columnToCanonical: new Map([
          ['EDAD', 'edad'],
          ['NIVACAD', 'nivel'],
        ]),
        missingCodes: new Map([
          ['EDAD', new Set(['999'])],
          ['NIVACAD', new Set(['99', '98'])],
        ]),
        rows: [
          { EDAD: '25', NIVACAD: '03' },
          { EDAD: '99', NIVACAD: '99' },
          { EDAD: '999', NIVACAD: '' },
          { EDAD: '', NIVACAD: ' ' },
          { EDAD: '0', NIVACAD: '00' },
          { EDAD: ' 999 ', NIVACAD: '98' },
        ],
      }),
    );
    expect(view.rows).toEqual([
      { edad: '25', nivel: '03' },
      { edad: '99', nivel: null },
      { edad: null, nivel: null },
      { edad: null, nivel: null },
      { edad: '0', nivel: '00' },
      { edad: null, nivel: null },
    ]);
  });

  it('dos columnas a la misma canónica: un solo header y en la fila gana la última', () => {
    const view = buildDatasetView(
      edition({
        columns: ['edad_a', 'edad_b'],
        columnToCanonical: new Map([
          ['edad_a', 'edad'],
          ['edad_b', 'edad'],
        ]),
        rows: [{ edad_a: '1', edad_b: '2' }],
      }),
    );
    expect(view.headers).toEqual(['edad']);
    expect(view.rows).toEqual([{ edad: '2' }]);
  });
});

describe('harmonizer: buildSurveyView', () => {
  const editions: DatasetEdition[] = [
    edition({
      name: 'ENIGH 2020',
      year: 2020,
      columns: ['age', 'sexo'],
      columnToCanonical: new Map([
        ['age', 'edad'],
        ['sexo', 'sexo'],
      ]),
      rows: [{ age: '30', sexo: 'M' }],
    }),
    edition({
      name: 'ENIGH 2021',
      year: 2021,
      columns: ['edad1'],
      columnToCanonical: new Map([['edad1', 'edad']]),
      rows: [{ edad1: '41' }],
    }),
  ];

  it('une ediciones y antepone _dataset/_year/_row', () => {
    const view = buildSurveyView(editions, ['edad', 'sexo']);
    expect(view.headers).toEqual(['edad', 'sexo']);
    expect(view.rows).toEqual([
      { edad: '30', sexo: 'M', _dataset: 'ENIGH 2020', _year: 2020, _row: 1 },
      { edad: '41', _dataset: 'ENIGH 2021', _year: 2021, _row: 1 },
    ]);
  });

  it('_row numera los registros de cada archivo, así que _dataset + _row es única aunque el id se repita', () => {
    const sameIds = (name: string) =>
      edition({
        name,
        columns: ['id', 'sexo'],
        columnToCanonical: new Map([
          ['id', 'id'],
          ['sexo', 'sexo'],
        ]),
        rows: [
          { id: '0001', sexo: '1' },
          { id: '0002', sexo: '2' },
        ],
      });
    const view = buildSurveyView([sameIds('A'), sameIds('B')], ['id', 'sexo']);
    expect(view.rows.map((r) => [r._dataset, r._row, r.id])).toEqual([
      ['A', 1, '0001'],
      ['A', 2, '0002'],
      ['B', 1, '0001'],
      ['B', 2, '0002'],
    ]);
  });

  it('los valores faltantes de cada edición llegan como null a la vista por encuesta', () => {
    const view = buildSurveyView(
      [
        edition({
          name: 'A',
          year: 2020,
          columns: ['hli'],
          columnToCanonical: new Map([['hli', 'hli']]),
          missingCodes: new Map([['hli', new Set(['9'])]]),
          rows: [{ hli: '1' }, { hli: '9' }],
        }),
        edition({
          name: 'B',
          year: 2021,
          columns: ['hli'],
          columnToCanonical: new Map([['hli', 'hli']]),
          rows: [{ hli: '9' }, { hli: '' }],
        }),
      ],
      ['hli'],
    );
    expect(view.rows.map((r) => r.hli)).toEqual(['1', null, '9', null]);
  });

  it('una fila que no aporta ninguna variable pedida se omite', () => {
    const view = buildSurveyView(editions, ['sexo']);
    expect(view.rows).toEqual([
      { sexo: 'M', _dataset: 'ENIGH 2020', _year: 2020, _row: 1 },
    ]);
  });

  it('headers devuelve wanted tal cual aunque no exista en ningún dataset', () => {
    const view = buildSurveyView(editions, ['edad', 'inexistente']);
    expect(view.headers).toEqual(['edad', 'inexistente']);
    expect(view.rows.every((r) => !('inexistente' in r))).toBe(true);
  });

  it('wanted vacío -> vista vacía', () => {
    expect(buildSurveyView(editions, [])).toEqual({ headers: [], rows: [] });
  });
});
