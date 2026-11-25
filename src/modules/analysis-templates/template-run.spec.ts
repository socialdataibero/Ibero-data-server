import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { AnalysisService } from '../analysis/analysis.service.js';
import { parseSourceMetadata, type SourceMetadata } from '../harmonizer/source-metadata.js';
import { listTemplates } from './template-catalog.js';
import { templateMetadata } from './template-metadata.js';
import { runTemplate, type ResultRow, type TemplateRequest } from './template-run.js';

/**
 * The real validation case of the template proposal (annex B): the Census 2000 sample of
 * Aguascalientes, 87,507 records. The expected files were computed separately in Polars by
 * `propuesta_plantillas/caso_real_censo2000_ags/calcular_esperados_censo2000.py`; the input is
 * the extract prepared for the demo by `demo-plantillas/preparar.mjs` (numbers typed, blanks as
 * null, "not specified" codes kept) with the source metadata (version 2, as the harmonizer writes
 * it) of `metadatos-censo2000-ags.json`.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/templates/${name}`, import.meta.url));
const PARQUET = fixture('censo2000_ags_demo.parquet');
const source = parseSourceMetadata(
  JSON.parse(readFileSync(fixture('metadatos-censo2000-ags.json'), 'utf8')),
)!;
const metadata = templateMetadata(source)!;
const analysis = new AnalysisService({ threads: '2' });
const run = (request: TemplateRequest) =>
  runTemplate(request, metadata, (queries, filter) => analysis.runInternalQueries(PARQUET, queries, filter));

type Expected = Record<string, string>;
const expected = (name: string): Expected[] =>
  parse(readFileSync(fixture(name), 'utf8'), { columns: true }) as Expected[];
const proportionExpected = expected('censo2000_ags_proporcion_esperado.csv');
const DISAGGREGATIONS = ['sexo', 'grupo_edad', 'escolaridad', 'actividad', 'ambito', 'habla'];
/** Rows where every disaggregation except `only` is «Todos». */
const allBut = (rows: Expected[], only?: string) =>
  rows.filter((r) => DISAGGREGATIONS.every((d) => r[d] === undefined || d === only || r[d] === 'Todos'));

const se = (v: number | null) => (v === null ? '' : v.toFixed(6));
const expectedSe = (v: string) => (v === '' ? '' : Number(v).toFixed(6));
const num = (v: string) => Number(v);

describe('proportion over the Census 2000 sample of Aguascalientes', () => {
  for (const [missing, escenario] of [
    ['exclude', 'excluir'],
    ['include', 'incluir'],
  ] as const) {
    it(`by municipality, both conditions, ${missing} "not specified"`, async () => {
      const result = await run({ templateId: 'proportion', conditions: ['HLENGUA', 'PERETN'], group: 'CVE_MUN', missing });
      const want = allBut(proportionExpected).filter((r) => r.escenario === escenario);
      expect(result.rows).toHaveLength(want.length);
      for (const w of want) {
        const got = result.rows.find((r) => r.criterio === w.criterio && r.cve === w.cve)!;
        expect(got, `${w.criterio} ${w.cve}`).toBeDefined();
        expect([got.nivel, got.nombre, got.num, got.den, got.den_total, got.casos]).toEqual([
          w.nivel,
          w.nombre,
          num(w.num),
          num(w.den),
          num(w.den_total),
          num(w.casos),
        ]);
        expect([se(got.ee), se(got.ee_total)]).toEqual([expectedSe(w.ee), expectedSe(w.ee_total)]);
      }
    });
  }

  it('the headline figure of the proposal (section 3.10)', async () => {
    const result = await run({ templateId: 'proportion', conditions: ['HLENGUA'], group: 'CVE_MUN' });
    const total = result.rows.find((r) => r.es_total)!;
    expect(total).toMatchObject({ nivel: 'entidad', cve: '01', nombre: 'Aguascalientes', num: 1793, den: 821364, den_total: 940778, casos: 148 });
    expect(se(total.ee)).toBe('0.000424');
    expect(result.texts.title).toBe('Habla lengua indígena por municipio');
    expect(result.texts.missing).toContain('266 registros');
  });

  for (const [column, disaggregation] of [
    ['SEXO', 'sexo'],
    ['GRUPO_EDAD', 'grupo_edad'],
    ['ACTIVIDAD', 'actividad'],
  ] as const) {
    it(`grouped by a non-geographic variable (${column}), with its "no aplica" and its total`, async () => {
      const result = await run({ templateId: 'proportion', conditions: ['HLENGUA'], group: column });
      const want = allBut(proportionExpected, disaggregation).filter(
        (r) => r.escenario === 'excluir' && r.nivel === 'entidad' && r.criterio.startsWith('Habla'),
      );
      expect(result.rows).toHaveLength(want.length);
      for (const w of want) {
        const label = w[disaggregation] === 'Todos' ? 'Todos' : w[disaggregation];
        const got = result.rows.find((r) => r.grupo === label) as ResultRow;
        expect(got, label).toBeDefined();
        expect([got.num, got.den, got.den_total, got.casos, se(got.ee), se(got.ee_total)]).toEqual([
          num(w.num),
          num(w.den),
          num(w.den_total),
          num(w.casos),
          expectedSe(w.ee),
          expectedSe(w.ee_total),
        ]);
      }
    });
  }

  it('flags groups with nobody in the universe instead of showing 0%', async () => {
    const result = await run({ templateId: 'proportion', conditions: ['HLENGUA'], group: 'GRUPO_EDAD' });
    expect(result.rows.find((r) => r.grupo === '0 a 4 años')).toMatchObject({ den: 0, ee: null });
    expect(result.warnings.map((w) => w.code)).toContain('empty_universe');
  });
});

describe('distribution over the Census 2000 sample', () => {
  for (const [missing, escenario] of [
    ['exclude', 'excluir'],
    ['include', 'incluir'],
  ] as const) {
    it(`schooling by municipality, ${missing} "not specified"`, async () => {
      const result = await run({ templateId: 'distribution', variable: 'ESCOLARIDAD', group: 'CVE_MUN', missing });
      const want = allBut(expected('censo2000_ags_distribucion_esperado.csv')).filter((r) => r.escenario === escenario);
      expect(result.rows).toHaveLength(want.length);
      for (const w of want) {
        const got = result.rows.find((r) => r.cve === w.cve && r.corte === w.corte)!;
        expect(got, `${w.cve} ${w.corte}`).toBeDefined();
        expect([got.num, got.den, got.casos, se(got.ee)]).toEqual([num(w.num), num(w.den), num(w.casos), expectedSe(w.ee)]);
      }
      expect(result.texts.title).toBe('Personas según escolaridad por municipio');
    });
  }
});

describe('weighted mean over the Census 2000 sample', () => {
  it('age by municipality, always without the 190 records of unknown age', async () => {
    const result = await run({ templateId: 'weighted_mean', measure: 'EDAD', group: 'CVE_MUN' });
    const want = allBut(expected('censo2000_ags_promedio_esperado.csv'));
    expect(result.rows).toHaveLength(want.length);
    for (const w of want) {
      const got = result.rows.find((r) => r.cve === w.cve)!;
      expect([got.num, got.den, got.casos, se(got.ee)]).toEqual([num(w.num), num(w.den), num(w.casos), expectedSe(w.ee)]);
    }
    expect(result.texts.missing).toBe(
      'Se excluyen 190 registros con «No especificado» en edad. El promedio se calcula sólo con quienes tienen dato.',
    );
    expect(result.charts.recommended).toBe('lollipop');
  });
});

describe('breakdowns over the Census 2000 sample', () => {
  const COLUMNS = { sexo: 'SEXO', grupo_edad: 'GRUPO_EDAD', escolaridad: 'ESCOLARIDAD', actividad: 'ACTIVIDAD', ambito: 'AMBITO', habla: 'HLENGUA' } as const;
  type Name = keyof typeof COLUMNS;
  /** Codes the expected files name differently from the catalog of the fixture. */
  const LABEL: Record<string, string> = {
    'habla|2': 'No habla (resto)',
    'escolaridad|': 'No aplica',
  };
  const labels = (result: Awaited<ReturnType<typeof run>>, row: ResultRow, name: Name) => {
    const d = result.dimensions.breakdowns.find((b) => b.column === COLUMNS[name]);
    const value = row.desagregaciones[COLUMNS[name]];
    return !d || value === null ? 'Todos' : LABEL[`${name}|${value}`] ?? d.categories.find((c) => c.code === value)!.label;
  };
  /** Every expected row split by exactly these, at the level `nivel`. */
  const wanted = (rows: Expected[], names: Name[], nivel: string) =>
    rows.filter((r) => r.nivel === nivel && DISAGGREGATIONS.every((d) => r[d] === undefined || (names.includes(d as Name) ? r[d] !== 'Todos' : r[d] === 'Todos')));

  const files = {
    proportion: ['censo2000_ags_proporcion_esperado.csv', { templateId: 'proportion', conditions: ['HLENGUA', 'PERETN'] }],
    distribution: ['censo2000_ags_distribucion_esperado.csv', { templateId: 'distribution', variable: 'ESCOLARIDAD' }],
    weighted_mean: ['censo2000_ags_promedio_esperado.csv', { templateId: 'weighted_mean', measure: 'EDAD' }],
  } as const;

  for (const [file, request] of Object.values(files)) {
    const all = expected(file);
    const present = (Object.keys(COLUMNS) as Name[]).filter((n) => all[0][n] !== undefined);
    const pairs = present.flatMap((a, i) => present.slice(i + 1).map((b) => [a, b]));
    const cases = [...present.map((n) => [n]), ...pairs].flatMap((names) =>
      ['entidad', 'municipio'].map((nivel) => ({ names, nivel, rows: wanted(all, names, nivel) })),
    );
    for (const { names, nivel, rows } of cases.filter((c) => c.rows.length > 0)) {
      for (const escenario of new Set(rows.map((r) => r.escenario))) {
        it(`${request.templateId} by ${names.join(' × ')}, ${nivel}, ${escenario ?? 'only'}`, async () => {
          const result = await run({
            ...request,
            conditions: 'conditions' in request ? [...request.conditions] : undefined,
            group: nivel === 'municipio' ? 'CVE_MUN' : null,
            breakdowns: names.map((n) => COLUMNS[n]),
            missing: escenario === 'incluir' ? 'include' : 'exclude',
          });
          const want = rows.filter((r) => r.escenario === escenario);
          // The breakdown of "habla" keeps "not specified" as a category, as the expected files do.
          const got = result.rows.filter(
            (r) => r.es_total === (nivel === 'entidad') && names.every((n) => r.desagregaciones[COLUMNS[n]] !== null),
          );
          const key = (r: ResultRow) => [r.criterio ?? '', r.cve, r.corte ?? '', ...names.map((n) => labels(result, r, n))].join('|');
          const byKey = new Map(got.map((r) => [key(r), r]));
          expect(got).toHaveLength(want.length);
          for (const w of want) {
            const k = [w.criterio ?? '', w.cve, w.corte ?? '', ...names.map((n) => w[n])].join('|');
            const g = byKey.get(k)!;
            expect(g, k).toBeDefined();
            expect([k, g.num, g.den, g.casos, se(g.ee)]).toEqual([k, num(w.num), num(w.den), num(w.casos), expectedSe(w.ee)]);
            if (w.den_total !== undefined) expect([g.den_total, se(g.ee_total)]).toEqual([num(w.den_total), expectedSe(w.ee_total)]);
          }
        });
      }
    }
  }

  it('the parts of each breakdown add up to «Todos»', async () => {
    const result = await run({ templateId: 'proportion', conditions: ['HLENGUA'], breakdowns: ['SEXO', 'GRUPO_EDAD'] });
    const at = (sex: string | null, age: 'all' | 'parts') =>
      result.rows.filter((r) => r.desagregaciones.SEXO === sex && (r.desagregaciones.GRUPO_EDAD === null) === (age === 'all'));
    for (const sex of [null, '1', '2']) {
      expect(at(sex, 'parts').reduce((n, r) => n + r.num, 0)).toBe(at(sex, 'all')[0].num);
      expect(at(sex, 'parts').reduce((n, r) => n + r.den_total!, 0)).toBe(at(sex, 'all')[0].den_total);
    }
  });

  it('cuts a measure into the groups declared in the harmonizer, equal to the prepared column', async () => {
    const cuts = [
      { from: 0, to: 4, label: '0 a 4 años' },
      { from: 5, to: 14, label: '5 a 14 años' },
      { from: 15, to: 29, label: '15 a 29 años' },
      { from: 30, to: 59, label: '30 a 59 años' },
      { from: 60, to: null, label: '60 años y más' },
    ];
    const withCuts = templateMetadata({
      ...source,
      columns: source.columns.map((c) => (c.name === 'EDAD' ? { ...c, disaggregation: { summable: true, cuts } } : c)),
    })!;
    const runCuts = (request: TemplateRequest) =>
      runTemplate(request, withCuts, (q, f) => analysis.runInternalQueries(PARQUET, q, f));
    const request = { templateId: 'proportion', conditions: ['HLENGUA'], breakdowns: ['SEXO'] };
    const figures = (r: Awaited<ReturnType<typeof run>>) =>
      r.rows.map((x) => [x.grupo, x.desagregaciones.SEXO, x.num, x.den, x.casos, se(x.ee)].join('|')).sort();
    expect(figures(await runCuts({ ...request, group: 'EDAD__grupos' }))).toEqual(
      figures(await run({ ...request, group: 'GRUPO_EDAD' })),
    );
    await expect(
      runCuts({ templateId: 'weighted_mean', measure: 'EDAD', breakdowns: ['EDAD__grupos'] }),
    ).rejects.toMatchObject({ response: { code: 'template_variable_in_two_roles' } });
  });

  it.each([
    [['SEXO', 'GRUPO_EDAD', 'ACTIVIDAD'], 'template_too_many_breakdowns'],
    [['EDAD'], 'template_breakdown_unavailable'],
    [['HLENGUA'], 'template_variable_in_two_roles'],
    [['CVE_MUN'], 'template_breakdown_unavailable'],
  ])('rejects %j with %s', async (breakdowns, code) => {
    await expect(run({ templateId: 'proportion', conditions: ['HLENGUA'], breakdowns })).rejects.toMatchObject({ response: { code } });
  });

  it('rejects more cells than the limit before running anything', async () => {
    const many = { ...metadata, columns: metadata.columns.map((c) =>
      ['SEXO', 'ACTIVIDAD'].includes(c.name) ? { ...c, categories: Array.from({ length: 30 }, (_, i) => ({ code: `${i}`, label: `${i}` })) } : c) };
    await expect(
      runTemplate({ templateId: 'proportion', conditions: ['HLENGUA'], group: 'CVE_MUN', breakdowns: ['SEXO', 'ACTIVIDAD'] }, many, () => {
        throw new Error('must not run');
      }),
    ).rejects.toMatchObject({ response: { code: 'template_too_many_cells' } });
  });
});

describe('template choices', () => {
  it('offers each input only the variables with a role it accepts', () => {
    const [proportion, distribution, mean] = listTemplates(metadata);
    expect(proportion.inputs[0].options.map((o) => o.column)).toEqual(['HLENGUA', 'PERETN', 'AMBITO']);
    expect(mean.inputs[0].options.map((o) => o.column)).toEqual(['EDAD']);
    expect(distribution.compatible).toBe(true);
    expect(listTemplates(null).every((t) => !t.compatible && t.reason?.code === 'template_no_metadata')).toBe(true);
  });

  it.each([
    [{ templateId: 'nope' }, 'template_not_found'],
    [{ templateId: 'proportion', conditions: [] }, 'template_input_count'],
    [{ templateId: 'proportion', conditions: ['EDAD'] }, 'template_input_role_mismatch'],
    [{ templateId: 'proportion', conditions: ['NOPE'] }, 'template_input_unknown'],
    [{ templateId: 'weighted_mean' }, 'template_input_required'],
    [{ templateId: 'proportion', conditions: ['AMBITO'], group: 'AMBITO' }, 'template_variable_in_two_roles'],
  ])('rejects %j with %s', async (request, code) => {
    await expect(run(request as TemplateRequest)).rejects.toMatchObject({ response: { code } });
  });

  it('a sample without an expansion factor cannot be used', async () => {
    const noWeight = { ...metadata, columns: metadata.columns.filter((c) => c.role !== 'weight') };
    await expect(
      runTemplate({ templateId: 'weighted_mean', measure: 'EDAD' }, noWeight, () => Promise.resolve([])),
    ).rejects.toMatchObject({ response: { code: 'template_factor_required' } });
  });
});

describe('the edition of the analysis', () => {
  // The same source as a survey view of two editions: `_dataset` and `_year` tell them apart.
  const two: SourceMetadata = {
    ...source,
    editions: [
      { ...source.editions[0], id: 'e2000', name: 'Muestra 2000', year: 2000 },
      { ...source.editions[0], id: 'e2010', name: "Muestra 2010 'b'", year: 2010, weight: 'FACTOR' },
    ],
    columns: [
      { name: '_dataset', type: 'VARCHAR' },
      { name: '_year', type: 'BIGINT' },
      { name: '_row', type: 'BIGINT' },
      ...source.columns.map((c) =>
        c.missingCount ? { ...c, missingCount: { e2000: 190, e2010: 12 } } : c,
      ),
    ],
  };

  it('a file of one edition needs no choice and filters nothing', () => {
    expect(metadata).toMatchObject({ edition: 2000, source: 'Censo 2000', rowFilter: null });
    expect(metadata.total).toEqual({ level: 'entidad', code: '01', label: 'Aguascalientes' });
    expect(metadata.editionInfo).toEqual({ id: 'censo2000-ags', name: 'Muestra censal 2000', year: 2000 });
  });

  it('a file of several editions asks for one, and keeps only its rows', () => {
    expect(() => templateMetadata(two)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'template_edition_required',
          params: { editions: [
            { id: 'e2000', name: 'Muestra 2000', year: 2000 },
            { id: 'e2010', name: "Muestra 2010 'b'", year: 2010 },
          ] },
        }),
      }),
    );
    expect(() => templateMetadata(two, 'nope')).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'template_edition_unknown' }) }),
    );
    const later = templateMetadata(two, 'e2010')!;
    expect(later.rowFilter).toBe(`"_dataset" = 'Muestra 2010 ''b''' AND "_year" = 2010`);
    expect(later.edition).toBe(2010);
    expect(later.columns.find((c) => c.name === 'EDAD')?.missingCount).toBe(12);
    // Listing the templates takes the first edition instead of asking.
    expect(templateMetadata(two, null, { pickFirst: true })?.edition).toBe(2000);
    expect(later.columns.some((c) => c.name.startsWith('_'))).toBe(false);
  });

  it('the factor is the edition\'s, and no metadata or no design is no template', () => {
    const otherFactor = templateMetadata({ ...two, editions: [two.editions[0], { ...two.editions[1], weight: 'UPM' }] }, 'e2010')!;
    expect(otherFactor.columns.filter((c) => c.role === 'weight').map((c) => c.name)).toEqual(['UPM']);
    expect(templateMetadata(null)).toBeNull();
    expect(templateMetadata({ ...source, design: null, editions: [{ ...source.editions[0], design: null }] })).toBeNull();
  });

  it('the strata of certainty are the edition\'s, and reach the standard error', async () => {
    const declared = (codes: string[], column = 'CVE_MUN') =>
      templateMetadata({ ...source, editions: [{ ...source.editions[0], certainty: { column, codes } }] })!;
    expect(declared(['01001']).certainty).toEqual({ column: 'CVE_MUN', codes: ['01001'] });
    expect(declared(['01001'], 'NOT_IN_FILE').certainty).toBeNull();
    expect(metadata.certainty).toBeNull();

    const request: TemplateRequest = { templateId: 'proportion', conditions: ['HLENGUA'], group: 'CVE_MUN' };
    const plain = await run(request);
    const withCapital = await runTemplate(request, declared(['01001']), (q, f) => analysis.runInternalQueries(PARQUET, q, f));
    const row = (rows: ResultRow[], cve: string) => rows.find((r) => r.cve === cve && !r.es_total)!;
    // The municipality enumerated completely has no sampling error; the others barely change
    // (with a declaration, a stratum where every weight is 1 is of certainty too).
    expect(row(plain.rows, '01001').ee).not.toBeNull();
    expect(row(withCapital.rows, '01001')).toMatchObject({ num: row(plain.rows, '01001').num, ee: null, ee_total: null });
    expect(se(row(withCapital.rows, '01002').ee)).toBe(se(row(plain.rows, '01002').ee));
    // The state total loses the variance of the capital's strata.
    const total = (rows: ResultRow[]) => rows.find((r) => r.es_total)!;
    expect(total(withCapital.rows).num).toBe(total(plain.rows).num);
    expect(total(withCapital.rows).ee!).toBeLessThan(total(plain.rows).ee!);
  });

  describe('a universe that depends on another variable (EDAD >= 15)', () => {
    // ESCOLARIDAD of the 2000 sample is asked from 5 years; here only 15 and more count.
    const withRule = (rule: { column: string; min: number } | null) =>
      templateMetadata({
        ...source,
        columns: source.columns.map((c) =>
          c.name === 'ESCOLARIDAD' ? { ...c, universe: 'población de 15 años y más', ...(rule ? { universeRule: rule } : {}) } : c,
        ),
      })!;
    const runWith = (request: TemplateRequest, meta = withRule({ column: 'EDAD', min: 15 })) =>
      runTemplate(request, meta, (q, f) => analysis.runInternalQueries(PARQUET, q, f));
    const adults = async () => {
      // The same 15+ total with a plain proportion: records with a known age of 15 or more.
      const r = await analysis.runInternalQueries(
        PARQUET,
        [`SELECT SUM(CAST(FACTOR AS DOUBLE)) FILTER (WHERE TRY_CAST(EDAD AS DOUBLE) >= 15 AND ESCOLARIDAD IS NOT NULL AND ESCOLARIDAD <> '9') FROM data`],
        null,
      );
      return Number(r[0][0][0]);
    };

    it('a distribution only counts the records inside the rule', async () => {
      const plain = await runWith({ templateId: 'distribution', variable: 'ESCOLARIDAD' }, withRule(null));
      const ruled = await runWith({ templateId: 'distribution', variable: 'ESCOLARIDAD' });
      const den = (rows: ResultRow[]) => rows.find((r) => r.es_total)!.den;
      expect(den(ruled.rows)).toBe(await adults());
      expect(den(ruled.rows)).toBeLessThan(den(plain.rows));
      // Every category adds up to the universe.
      const totals = ruled.rows.filter((r) => r.es_total);
      expect(totals.reduce((a, r) => a + r.num, 0)).toBe(den(ruled.rows));
    });

    it('as a group, the records outside the rule are «no aplica»', async () => {
      const result = await runWith({ templateId: 'proportion', conditions: ['HLENGUA'], group: 'ESCOLARIDAD' });
      const outside = result.rows.find((r) => r.grupo_codigo === '')!;
      expect(outside.grupo).toBe('No aplica (menores de 5 años)');
      const groups = result.rows.filter((r) => !r.es_total);
      // The groups still add up to the whole: nobody is lost, those under 15 move to «no aplica».
      expect(groups.reduce((a, r) => a + (r.den_total ?? 0), 0)).toBe(result.rows.find((r) => r.es_total)!.den_total);
    });

    it('a rule on a column that is not in the file is an error, not a wider universe', async () => {
      await expect(
        runWith({ templateId: 'distribution', variable: 'ESCOLARIDAD' }, withRule({ column: 'EDAD_X', min: 15 })),
      ).rejects.toMatchObject({ response: { code: 'template_universe_variable_missing' } });
    });
  });

  it('the filter reaches DuckDB: rows outside the edition are not counted', async () => {
    const all = await run({ templateId: 'proportion', conditions: ['HLENGUA'] });
    const men = await runTemplate({ templateId: 'proportion', conditions: ['HLENGUA'] }, { ...metadata, rowFilter: `"SEXO" = '1'` }, (q, f) =>
      analysis.runInternalQueries(PARQUET, q, f),
    );
    const bySex = await run({ templateId: 'proportion', conditions: ['HLENGUA'], group: 'SEXO' });
    expect(all.rows[0].den_total).toBe(940778);
    expect(men.rows[0].den_total).toBe(bySex.rows.find((r) => r.grupo_codigo === '1')!.den_total);
    expect(men.rows[0].den_total).toBeLessThan(940778);
  });
});
