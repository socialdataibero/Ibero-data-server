import {
  buildDatasetView,
  buildSurveyView,
  columnValues,
  inferValueType,
  neutralizeCsvFormula,
  sourceColumnValues,
  valuesNotFitting,
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
    rowOffset: partial.rowOffset,
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

  it('con rowOffset (una página de la edición), _row sigue contando desde el inicio del archivo', () => {
    const page = edition({
      name: 'A',
      columns: ['id'],
      columnToCanonical: new Map([['id', 'id']]),
      rows: [{ id: '0101' }, { id: '0102' }],
      rowOffset: 100,
    });
    const view = buildSurveyView([page], ['id']);
    expect(view.rows.map((r) => [r._row, r.id])).toEqual([
      [101, '0101'],
      [102, '0102'],
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

describe('harmonizer: neutralizeCsvFormula (H-12)', () => {
  it('antepone apóstrofo a lo que Excel evaluaría como fórmula', () => {
    expect(neutralizeCsvFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeCsvFormula('+1+1')).toBe("'+1+1");
    expect(neutralizeCsvFormula('-1+1')).toBe("'-1+1");
    expect(neutralizeCsvFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeCsvFormula('\t=1')).toBe("'\t=1");
    expect(neutralizeCsvFormula('-')).toBe("'-");
  });

  it('deja intactos números simples y texto normal', () => {
    for (const v of ['-5', '+3.2', '-0.5', '-.5', '1e-3', '-2E+4', '12', 'Mérida', '', 'a=b', ' =1']) {
      expect(neutralizeCsvFormula(v)).toBe(v);
    }
  });
});

describe('harmonizer: inferValueType', () => {
  it('enteros, con signo y espacios, ignorando nulos y vacíos', () => {
    expect(inferValueType(['23', ' -4 ', '+7', null, '', '0'])).toBe('integer');
  });

  it('un decimal en la columna la vuelve decimal', () => {
    expect(inferValueType(['1', '2.5', '1e3', '.5'])).toBe('decimal');
  });

  it('un cero inicial la deja como texto (clave "01")', () => {
    expect(inferValueType(['10', '01'])).toBe('text');
    expect(inferValueType(['01.5'])).toBe('text');
  });

  it('cualquier valor no numérico la deja como texto', () => {
    expect(inferValueType(['1', 'NS'])).toBe('text');
    expect(inferValueType(['NaN'])).toBe('text');
  });

  it('identificadores de más de 15 dígitos quedan como texto', () => {
    expect(inferValueType(['1234567890123456'])).toBe('text');
  });

  it('un número que desborda DOUBLE (1e309) la deja como texto', () => {
    expect(inferValueType(['1', '1e309'])).toBe('text');
  });

  it('sin valores queda como texto', () => {
    expect(inferValueType([null, '  '])).toBe('text');
  });
});

describe('harmonizer: valuesNotFitting', () => {
  it('texto acepta todo', () => {
    expect(valuesNotFitting(['x', '1'], 'text')).toEqual([]);
  });

  it('entero rechaza decimales y texto, sin repetir y con límite', () => {
    expect(
      valuesNotFitting(['1', '2.5', 'NS', 'NS', null, ''], 'integer'),
    ).toEqual(['2.5', 'NS']);
    expect(valuesNotFitting(['a', 'b', 'c'], 'decimal', 2)).toEqual(['a', 'b']);
  });

  it('decimal rechaza lo que desborda DOUBLE', () => {
    expect(valuesNotFitting(['1.5', '1e309'], 'decimal')).toEqual(['1e309']);
  });

  it('entero acepta ceros iniciales cuando el usuario lo confirma', () => {
    expect(valuesNotFitting(['01', '007'], 'integer')).toEqual([]);
  });

  it('entero rechaza lo que no cabe en 64 bits', () => {
    expect(valuesNotFitting(['9223372036854775808'], 'integer')).toEqual([
      '9223372036854775808',
    ]);
  });
});

describe('harmonizer: sourceColumnValues', () => {
  it('aplica vacíos y códigos de no especificado', () => {
    expect(
      sourceColumnValues(
        [{ a: '1' }, { a: ' ' }, { a: '99' }, {}],
        'a',
        new Set(['99']),
      ),
    ).toEqual(['1', null, null, null]);
  });
});

describe('harmonizer: columnValues', () => {
  it('cuenta los valores recortados, del más frecuente al menos, y aparte las vacías', () => {
    const rows = ['2', '1', ' 1', '9', '', '2', '1', '  ', '3'].map((a) => ({ a }));
    rows.push({} as { a: string });
    expect(columnValues(rows, 'a', 3)).toEqual({
      top: [
        { value: '1', count: 3 },
        { value: '2', count: 2 },
        { value: '9', count: 1 },
      ],
      distinct: 4,
      distinctCapped: false,
      empty: 3,
    });
  });

  it('no quita los códigos de no especificado', () => {
    expect(columnValues([{ a: '99' }, { a: '1' }], 'a').top).toEqual([
      { value: '99', count: 1 },
      { value: '1', count: 1 },
    ]);
  });

  it('deja de contar valores nuevos en el tope y lo indica', () => {
    const rows = ['a', 'b', 'c', 'a', 'd'].map((x) => ({ x }));
    expect(columnValues(rows, 'x', 5, 2)).toEqual({
      top: [
        { value: 'a', count: 2 },
        { value: 'b', count: 1 },
      ],
      distinct: 2,
      distinctCapped: true,
      empty: 0,
    });
  });
});
