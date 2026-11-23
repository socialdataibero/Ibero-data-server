import { describe, expect, it } from 'vitest';
import { compareVariable, type ComparisonEditionInput } from '../comparison.js';
import type { CodebookCategory } from '../codebook.js';
import { variableCategories } from './metadata-categories.js';

function input(
  id: string,
  year: number,
  values: Record<string, number>,
  opts: { codebook?: [string, string, CodebookCategory['kind']?][]; missing?: string[]; valueMap?: Record<string, string>; capped?: boolean } = {},
): ComparisonEditionInput {
  return {
    datasetId: id,
    datasetName: id,
    year,
    column: 'COL',
    missingCodes: opts.missing ?? [],
    keepMissingCodes: true,
    valueMap: opts.valueMap ?? {},
    profile: {
      values: Object.entries(values).map(([value, count]) => ({ value, count })),
      distinctCapped: opts.capped ?? false,
      empty: 0,
    },
    codebook: opts.codebook
      ? { label: 'Variable', categories: opts.codebook.map(([code, label, kind]) => ({ code, label, kind: kind ?? 'value' })) }
      : null,
  };
}

const run = (
  role: Parameters<typeof variableCategories>[0],
  inputs: ComparisonEditionInput[],
  catalog: { code: string; label: string }[] = [],
  missing: string[] = [],
) => variableCategories(role, catalog, inputs, compareVariable(inputs, catalog, 'text').editions, missing);

describe('variableCategories', () => {
  it('only variables of categories have them', () => {
    const inputs = [input('a', 2020, { '1': 3, '2': 4 })];
    expect(run('measure', inputs)).toEqual([]);
    expect(run('identifier', inputs)).toEqual([]);
    expect(run(null, inputs)).toEqual([]);
    expect(run('category', inputs)).toHaveLength(2);
  });

  it('with a common catalog: its codes in its order, then the kept "not specified" codes', () => {
    const inputs = [input('a', 2015, { H: 3, M: 4, '9': 1 }, { missing: ['9'], valueMap: { H: '1', M: '2', '9': '99' }, codebook: [['9', 'No especificado', 'missing']] })];
    expect(run('category', inputs, [{ code: '2', label: 'Mujer' }, { code: '1', label: 'Hombre' }], ['99'])).toEqual([
      { code: '2', label: 'Mujer', kind: 'value' },
      { code: '1', label: 'Hombre', kind: 'value' },
      { code: '99', label: 'No especificado', kind: 'missing' },
    ]);
  });

  it('without one: the dictionaries from the newest edition, written as in the data, then the other data codes', () => {
    const inputs = [
      input('a', 2015, { '1': 3, '2': 4, '7': 1 }, { codebook: [['01', 'Sí'], ['02', 'No'], ['03', 'Tal vez']] }),
      input('b', 2020, { '1': 5, '2': 6, '99': 2 }, { missing: ['99'], codebook: [['1', 'Sí habla'], ['99', 'No especificado', 'missing']] }),
    ];
    expect(run('dichotomous', inputs, [], ['99'])).toEqual([
      { code: '1', label: 'Sí habla', kind: 'value' },
      { code: '99', label: 'No especificado', kind: 'missing' },
      { code: '2', label: 'No', kind: 'value' },
      // In the dictionary but not in the data: written as the dictionary does.
      { code: '03', label: 'Tal vez', kind: 'value' },
      { code: '7', label: null, kind: 'value' },
    ]);
  });

  it('a capped profile does not add data codes, which would be incomplete', () => {
    const inputs = [input('a', 2020, { '001': 3, '002': 4 }, { capped: true, codebook: [['001', 'Aguascalientes']] })];
    expect(run('geographic', inputs)).toEqual([{ code: '001', label: 'Aguascalientes', kind: 'value' }]);
  });
});
