import { describe, expect, it } from 'vitest';
import { parseVariableMetadata, readVariableMetadata } from './variable-metadata.js';

const valid = () => ({
  version: 1,
  title: 'Encuesta de prueba',
  source: 'prueba',
  edition: 2020,
  design: 'sample',
  unit: 'person',
  unitPlural: 'personas',
  total: { level: 'entidad', code: '01', label: 'Entidad A' },
  columns: [
    { name: 'FACTOR', role: 'weight', label: 'Factor' },
    {
      name: 'HLI',
      role: 'dichotomous',
      label: 'Habla lengua indígena',
      positiveValue: '1',
      categories: [{ code: '1', label: 'Sí' }],
      missingCodes: ['9'],
      extra: 'ignored',
    },
  ],
});

const problem = (value: unknown, columns: string[] | null = null) => {
  try {
    parseVariableMetadata(value, columns);
    return null;
  } catch (err) {
    return (err as { response: { code: string; params: { path: string } } }).response;
  }
};

describe('parseVariableMetadata', () => {
  it('keeps the properties it knows and drops the rest', () => {
    const parsed = parseVariableMetadata(valid(), ['FACTOR', 'HLI', 'OTRA']);
    expect(parsed.columns[1]).toEqual({
      name: 'HLI',
      role: 'dichotomous',
      label: 'Habla lengua indígena',
      positiveValue: '1',
      categories: [{ code: '1', label: 'Sí' }],
      missingCodes: ['9'],
    });
  });

  it.each([
    ['a column the file does not have', (m: ReturnType<typeof valid>) => m, ['FACTOR'], 'metadata.columns[1].name'],
    ['an unknown role', (m: ReturnType<typeof valid>) => ({ ...m, columns: [{ ...m.columns[0], role: 'x' }] }), null, 'metadata.columns[0].role'],
    ['a dichotomous variable without its "yes"', (m: ReturnType<typeof valid>) => ({ ...m, columns: [{ name: 'A', role: 'dichotomous', label: 'A' }] }), null, 'metadata.columns[0].positiveValue'],
    ['two weights', (m: ReturnType<typeof valid>) => ({ ...m, columns: [m.columns[0], { ...m.columns[0], name: 'F2' }] }), null, 'metadata.columns'],
    ['a repeated column', (m: ReturnType<typeof valid>) => ({ ...m, columns: [m.columns[1], m.columns[1]] }), null, 'metadata.columns[1].name'],
    ['another design', (m: ReturnType<typeof valid>) => ({ ...m, design: 'other' }), null, 'metadata.design'],
  ])('rejects %s', (_, change, columns, path) => {
    expect(problem(change(valid()), columns)).toMatchObject({ code: 'variable_metadata_invalid', params: { path } });
  });

  it('reading never throws: invalid or missing metadata is null', () => {
    expect(readVariableMetadata(null)).toBeNull();
    expect(readVariableMetadata({ version: 2 })).toBeNull();
    expect(readVariableMetadata(valid())?.columns).toHaveLength(2);
  });
});
