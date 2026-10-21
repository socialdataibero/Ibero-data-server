import { BadRequestException } from '@nestjs/common';
import { buildRecipeSql, stepsToInternal, type Step } from './recipe.js';

describe('recipe: validación de campos obligatorios por paso', () => {
  it('paso "sort" sin columna: mensaje claro, no llega a generar SQL', () => {
    const steps: Step[] = [{ op: 'sort', params: { column: '', dir: 'desc' } }];
    expect(() => stepsToInternal(steps)).toThrow(BadRequestException);
    expect(() => stepsToInternal(steps)).toThrow(/"Sort" step/);
  });

  it('paso "join" con algún campo vacío: mensaje claro por campo faltante', () => {
    expect(() =>
      stepsToInternal([{ op: 'join', params: { resourceId: 'r2', alias: '', type: 'inner', onLeft: 'a', onRight: 'b' } }]),
    ).toThrow(/alias/);
    expect(() =>
      stepsToInternal([{ op: 'join', params: { resourceId: '', alias: 'x', type: 'inner', onLeft: 'a', onRight: 'b' } }]),
    ).toThrow(/"Join" step/);
  });

  it('paso "group_by" sin columnas seleccionadas', () => {
    expect(() => stepsToInternal([{ op: 'group_by', params: { columns: [] } }])).toThrow(/at least one selected column/);
  });

  it('paso "limit" vacío o en cero', () => {
    expect(() => stepsToInternal([{ op: 'limit', params: { n: '' } }])).toThrow(/"Limit rows"/);
    expect(() => stepsToInternal([{ op: 'limit', params: { n: 0 } }])).toThrow(/greater than 0/);
  });

  it('paso "filter" sí permite un valor vacío a propósito (columna = cadena vacía)', () => {
    const recipe = stepsToInternal([{ op: 'filter', params: { column: 'nombre', operator: '=', value: '' } }]);
    expect(recipe.filters[0].value).toBe('');
  });
});

describe('recipe: join / merge entre recursos', () => {
  describe('stepsToInternal', () => {
    it('traduce un paso join a JoinSpec', () => {
      const steps: Step[] = [
        {
          op: 'join',
          params: { resourceId: 'res-2', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio_hogar' },
        },
      ];

      const recipe = stepsToInternal(steps);

      expect(recipe.joins).toEqual([
        { resourceId: 'res-2', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio_hogar' },
      ]);
    });

    it('acumula varios joins en orden', () => {
      const steps: Step[] = [
        { op: 'join', params: { resourceId: 'a', alias: 'a1', type: 'inner', onLeft: 'x', onRight: 'x' } },
        { op: 'join', params: { resourceId: 'b', alias: 'b1', type: 'left', onLeft: 'y', onRight: 'y' } },
      ];

      const recipe = stepsToInternal(steps);

      expect(recipe.joins.map((j) => j.alias)).toEqual(['a1', 'b1']);
    });
  });

  describe('buildRecipeSql', () => {
    it('genera un INNER JOIN contra data con columnas entrecomilladas', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toContain('INNER JOIN "expansion" ON data."folio" = "expansion"."folio"');
      expect(sql).toMatch(/^SELECT \* FROM data INNER JOIN/);
    });

    it('genera un LEFT JOIN cuando el tipo es left', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'e', type: 'left', onLeft: 'a', onRight: 'b' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toContain('LEFT JOIN "e" ON data."a" = "e"."b"');
    });

    it('rechaza tipos de join no permitidos (solo inner/left)', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'e', type: 'full outer', onLeft: 'a', onRight: 'b' } },
      ]);

      expect(() => buildRecipeSql(recipe, null)).toThrow(BadRequestException);
      expect(() => buildRecipeSql(recipe, null)).toThrow(/Join type not allowed/);
    });

    it('encadena varios joins, todos contra data (no join sobre join)', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'e1', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
        { op: 'join', params: { resourceId: 'r3', alias: 'e2', type: 'left', onLeft: 'folio', onRight: 'folio' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toContain('data INNER JOIN "e1" ON data."folio" = "e1"."folio" LEFT JOIN "e2" ON data."folio" = "e2"."folio"');
    });

    it('escapa comillas dobles en el alias (identificador entrecomillado)', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'raro"alias', type: 'inner', onLeft: 'a', onRight: 'b' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toContain('"raro""alias"');
    });

    it('regresión: un compute posterior al join no debe perder el join (FROM debe referir el join, no "data" a secas)', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
        { op: 'compute', params: { left: 'ingreso', right: 'factor', as: 'ingreso_ponderado' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      // El join tiene que seguir presente y el compute debe envolver esa
      // combinación (data + join), no solo "data".
      expect(sql).toContain('INNER JOIN "expansion"');
      expect(sql).toMatch(/FROM \(SELECT \*, .*ingreso_ponderado.* FROM data INNER JOIN "expansion".*\) AS data/);
    });

    it('join + group_by + aggregate: agrupa sobre el resultado ya cruzado', () => {
      const recipe = stepsToInternal([
        { op: 'join', params: { resourceId: 'r2', alias: 'expansion', type: 'inner', onLeft: 'folio', onRight: 'folio' } },
        { op: 'group_by', params: { columns: ['municipio'] } },
        { op: 'aggregate', params: { func: 'SUM', column: 'ingreso', as: 'total_ingreso' } },
      ]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toContain('INNER JOIN "expansion"');
      expect(sql).toContain('SUM("ingreso") AS "total_ingreso"');
      expect(sql).toContain('GROUP BY "municipio"');
    });

    it('sin joins, se comporta exactamente como antes (FROM data simple)', () => {
      const recipe = stepsToInternal([{ op: 'limit', params: { n: 10 } }]);

      const { sql } = buildRecipeSql(recipe, null);

      expect(sql).toBe('SELECT * FROM data LIMIT 10');
    });
  });
});

describe('recipe: aggregate results in row-by-row steps (SDI-96)', () => {
  const sum: Step = { op: 'aggregate', params: { func: 'SUM', column: 'ingreso', as: 'total' } };

  it.each<[string, Step]>([
    ['group_by', { op: 'group_by', params: { columns: ['municipio', 'total'] } }],
    ['filter', { op: 'filter', params: { column: 'total', operator: '>', value: 1 } }],
    ['aggregate', { op: 'aggregate', params: { func: 'MAX', column: 'total', as: 'max_total' } }],
    ['compute', { op: 'compute', params: { left: 'total', right: 2, as: 'doble' } }],
  ])('rejects an aggregate result in a %s step', (op, step) => {
    expect(() => buildRecipeSql(stepsToInternal([sum, step]), null)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'aggregate_result_not_allowed', params: { column: 'total', op } }) }),
    );
  });

  it('still allows sorting by an aggregate result', () => {
    const steps: Step[] = [
      { op: 'group_by', params: { columns: ['municipio'] } },
      sum,
      { op: 'sort', params: { column: 'total', dir: 'desc' } },
    ];
    expect(buildRecipeSql(stepsToInternal(steps), null).sql).toContain('ORDER BY "total" DESC');
  });
});

describe('recipe: options that never work (SDI-96)', () => {
  it.each(['SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN'])('rejects %s(*)', (func) => {
    const steps: Step[] = [{ op: 'aggregate', params: { func, column: '*', as: 'r' } }];
    expect(() => buildRecipeSql(stepsToInternal(steps), null)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'star_requires_count', params: { func } }) }),
    );
  });

  it('allows COUNT(*)', () => {
    const steps: Step[] = [{ op: 'aggregate', params: { func: 'COUNT', column: '*', as: 'n' } }];
    expect(buildRecipeSql(stepsToInternal(steps), null).sql).toContain('COUNT(*)');
  });

  it.each<[string, Step[]]>([
    ['group by municipio, sort by folio', [
      { op: 'group_by', params: { columns: ['municipio'] } },
      { op: 'sort', params: { column: 'folio', dir: 'asc' } },
    ]],
    ['aggregate without group, sort by a file column', [
      { op: 'aggregate', params: { func: 'SUM', column: 'ingreso', as: 'total' } },
      { op: 'sort', params: { column: 'folio', dir: 'asc' } },
    ]],
  ])('rejects sorting by an ungrouped column: %s', (_name, steps) => {
    expect(() => buildRecipeSql(stepsToInternal(steps), null)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'sort_column_not_grouped', params: { column: 'folio' } }) }),
    );
  });

  it('sorts by a grouped column, an aggregate or a percentage result', () => {
    const steps: Step[] = [
      { op: 'group_by', params: { columns: ['municipio'] } },
      { op: 'aggregate', params: { func: 'SUM', column: 'ingreso', as: 'total' } },
      { op: 'percentage', params: { of: 'total', as: 'pct' } },
      { op: 'sort', params: { column: 'municipio', dir: 'asc' } },
      { op: 'sort', params: { column: 'pct', dir: 'desc' } },
    ];
    expect(buildRecipeSql(stepsToInternal(steps), null).sql).toContain('ORDER BY "municipio" ASC, "pct" DESC');
  });

  it('sorts by any column when nothing is grouped', () => {
    const steps: Step[] = [{ op: 'sort', params: { column: 'folio', dir: 'asc' } }];
    expect(buildRecipeSql(stepsToInternal(steps), null).sql).toContain('ORDER BY "folio" ASC');
  });
});
