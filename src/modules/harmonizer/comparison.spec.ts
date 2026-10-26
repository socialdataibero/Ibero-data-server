import { describe, expect, it } from 'vitest';
import type { CodebookCategory } from './codebook.js';
import {
  compareVariable,
  comparisonStatus,
  suggestRecoding,
  type ComparisonEditionInput,
} from './comparison.js';

function edition(
  name: string,
  year: number,
  values: Record<string, number>,
  opts: {
    categories?: [string, string][];
    missing?: string[];
    valueMap?: Record<string, string>;
    capped?: boolean;
  } = {},
): ComparisonEditionInput {
  const categories: CodebookCategory[] | undefined = opts.categories?.map(([code, label]) => ({
    code,
    label,
    kind: label.startsWith('No especificado') ? 'missing' : 'value',
  }));
  return {
    datasetId: `id-${name}`,
    datasetName: name,
    year,
    column: 'COL',
    missingCodes: opts.missing ?? [],
    valueMap: opts.valueMap ?? {},
    profile: {
      values: Object.entries(values).map(([value, count]) => ({ value, count })),
      distinctCapped: opts.capped ?? false,
      empty: 0,
    },
    codebook: categories ? { label: 'Variable', categories } : null,
  };
}

const CLAVIVP_2010 = edition(
  '2010',
  2010,
  { '1': 50, '2': 20, '9': 3 },
  {
    categories: [
      ['1', 'Casa independiente'],
      ['2', 'Departamento en edificio'],
      ['9', 'No especificado'],
    ],
    missing: ['9'],
  },
);
const CLAVIVP_2020 = edition(
  '2020',
  2020,
  { '01': 40, '02': 10, '04': 15 },
  {
    categories: [
      ['01', 'Casa única en el terreno'],
      ['02', 'Casa que comparte terreno con otra(s)'],
      ['04', 'Departamento en edificio'],
      ['99', 'No especificado de vivienda particular'],
    ],
  },
);

describe('compareVariable', () => {
  it('flags the same code with another meaning and the same meaning with another code', () => {
    const { categorical, issues } = compareVariable([CLAVIVP_2010, CLAVIVP_2020], [], 'text');
    expect(categorical).toBe(true);
    const byKind = (kind: string) => issues.filter((i) => i.kind === kind);
    expect(byKind('label_conflict').map((i) => i.subject)).toEqual(['1', '2']);
    expect(byKind('label_conflict')[1].editions).toEqual([
      { datasetName: '2010', year: 2010, codes: ['2'], label: 'Departamento en edificio' },
      { datasetName: '2020', year: 2020, codes: ['02'], label: 'Casa que comparte terreno con otra(s)' },
    ]);
    expect(byKind('code_conflict')).toEqual([
      {
        kind: 'code_conflict',
        subject: 'Departamento en edificio',
        editions: [
          { datasetName: '2010', year: 2010, codes: ['2'], label: 'Departamento en edificio' },
          { datasetName: '2020', year: 2020, codes: ['04'], label: 'Departamento en edificio' },
        ],
      },
    ]);
    // `9` es «No especificado» en 2010: no se compara.
    expect(issues.some((i) => i.subject === '9')).toBe(false);
  });

  it('reports codes that only some editions use, and nothing when the codes agree', () => {
    const a = edition('A', 2015, { '1': 5, '2': 5 }, { categories: [['1', 'Sí'], ['2', 'No']] });
    const b = edition('B', 2020, { '1': 5, '2': 5, '3': 1 }, { categories: [['1', 'Sí'], ['2', 'No'], ['3', 'Tal vez']] });
    expect(compareVariable([a, b], [], null).issues).toEqual([
      {
        kind: 'only_in_some',
        subject: '3',
        editions: [{ datasetName: 'B', year: 2020, codes: ['3'], label: 'Tal vez' }],
      },
    ]);
    const same = compareVariable([a, { ...a, datasetId: 'other', datasetName: 'C' }], [], null);
    expect(same.issues).toEqual([]);
    expect(comparisonStatus(same, null)).toBe('ok');
  });

  it('compares letters and numbers without a dictionary when there are few values', () => {
    const a = edition('A', 2015, { '1': 10, '2': 12 });
    const b = edition('B', 2020, { H: 10, M: 12 });
    const { categorical, issues } = compareVariable([a, b], [], null);
    expect(categorical).toBe(true);
    expect(issues.map((i) => [i.kind, i.subject])).toEqual([
      ['only_in_some', '1'],
      ['only_in_some', '2'],
      ['only_in_some', 'H'],
      ['only_in_some', 'M'],
    ]);
  });

  it('reports zero padding once for a numeric variable kept as text, and not when it is a number', () => {
    const ages = (prefix: string) =>
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${prefix}${i + 10}`, 1]));
    const a = edition('2010', 2010, ages('0'));
    const b = edition('2020', 2020, ages(''));
    const asText = compareVariable([a, b], [], null);
    expect(asText.categorical).toBe(false);
    expect(asText.issues).toHaveLength(1);
    expect(asText.issues[0]).toMatchObject({ kind: 'format', subject: '10, 11, 12, 13, 14' });
    expect(compareVariable([a, b], [], 'integer').issues).toEqual([]);
  });

  it('takes the catalog label for a value recoded to itself, which settles a label difference', () => {
    const catalog = [{ code: '05', label: 'Centro de salud' }];
    const a = edition('A', 2010, { '05': 3 }, { categories: [['05', 'Centro de salud (SSA)']], valueMap: { '05': '05' } });
    const b = edition('B', 2020, { '05': 4 }, { categories: [['05', 'Centro de salud u hospital']], valueMap: { '05': '05' } });
    expect(compareVariable([a, b], catalog, null).issues).toEqual([]);
    const unsettled = compareVariable([{ ...a, valueMap: {} }, b], catalog, null);
    expect(unsettled.issues.map((i) => i.kind)).toEqual(['label_conflict']);
  });

  it('applies the recoding and checks it against the catalog', () => {
    const catalog = [
      { code: '1', label: 'Hombre' },
      { code: '3', label: 'Mujer' },
    ];
    const a = edition('A', 2015, { '1': 10, '2': 12 }, { valueMap: { '2': '3' } });
    const b = edition('B', 2020, { '1': 10, '3': 12, '8': 1 });
    const { editions, issues } = compareVariable([a, b], catalog, null);
    expect(editions[0].values).toEqual([
      { value: '1', code: '1', label: 'Hombre', sourceLabel: null, count: 10, missing: false, recoded: false },
      { value: '2', code: '3', label: 'Mujer', sourceLabel: null, count: 12, missing: false, recoded: true },
    ]);
    expect(issues.map((i) => [i.kind, i.subject])).toEqual([
      ['only_in_some', '8'],
      ['not_in_catalog', '8'],
    ]);
  });

  it('changes the signature when the differences change, which brings the warning back', () => {
    const a = edition('A', 2015, { '1': 5 });
    const b = edition('B', 2020, { '1': 5, '2': 1 });
    const first = compareVariable([a, b], [], null);
    expect(comparisonStatus(first, first.signature)).toBe('reviewed');
    const later = compareVariable([a, edition('B', 2020, { '1': 5, '2': 1, '3': 1 })], [], null);
    expect(later.signature).not.toBe(first.signature);
    expect(comparisonStatus(later, first.signature)).toBe('warning');
    expect(comparisonStatus(compareVariable([a], [], null), null)).toBe('single');
  });
});

describe('suggestRecoding', () => {
  it('takes the newest dictionary as catalog and matches the other edition by label', () => {
    const { categories, valueMaps } = suggestRecoding([CLAVIVP_2010, CLAVIVP_2020], []);
    expect(categories.map((c) => c.code)).toEqual(['01', '02', '04']);
    // «Departamento en edificio» pasa de 2 a 04; «Casa independiente» no tiene par y no se propone.
    expect(valueMaps['id-2010']).toEqual({ '2': '04' });
    expect(valueMaps['id-2020']).toEqual({ '01': '01', '02': '02', '04': '04' });
  });

  it('matches a label that starts like another and fixes padding when labels agree', () => {
    const old = edition('2010', 2010, { '3': 1, '6': 1 }, {
      categories: [
        ['3', 'Vivienda en vecindad'],
        ['6', 'Vivienda móvil'],
      ],
    });
    const catalog = [
      { code: '05', label: 'Vivienda en vecindad o cuartería' },
      { code: '06', label: 'Vivienda móvil' },
    ];
    expect(suggestRecoding([old], catalog).valueMaps['id-2010']).toEqual({ '3': '05', '6': '06' });
    const noLabels = edition('X', 2000, { '1': 1, '7': 1 });
    expect(suggestRecoding([noLabels], [{ code: '01', label: '' }]).valueMaps['id-X']).toEqual({ '1': '01' });
  });
});
