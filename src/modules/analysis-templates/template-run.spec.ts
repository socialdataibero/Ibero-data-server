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
